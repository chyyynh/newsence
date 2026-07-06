import { ingestUrls } from '@ingest/urls';
import type { DbClient } from '@shared/db';
import { withDbClient } from '@shared/db';
import type { Env } from '@shared/types';
import { canCreateWorkspaceForPlan } from '@worker-contracts/billing-contracts';
import type {
	AddDocumentResourceResult,
	AddResourceToSourceResult,
	AddResourceUrlsToSourceResult,
	RemoveResourceResult,
	ResourceSourceType,
	ResourceTargetType,
	ValidateResourceSourceResult,
	WorkspaceCatalogResult,
	WorkspaceCreationCapability,
} from '@worker-contracts/core-rpc';

type ResourceSource = { type: ResourceSourceType; id: string };
type ResourceTarget = { type: ResourceTargetType; id: string };
type WorkspaceCapabilityRow = { plan_id: string | null; workspace_count: string | number };
type WorkspaceCatalogRow = WorkspaceCapabilityRow & {
	id: string | null;
	title: string | null;
	description: string | null;
	document_count: string | number | null;
};

function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function dateIso(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function cleanHttpUrls(urls: string[], limit = 20): string[] {
	const cleaned = urls
		.map((url) => url.trim())
		.filter(Boolean)
		.flatMap((url) => {
			try {
				const parsed = new URL(url);
				return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? [parsed.toString()] : [];
			} catch {
				return [];
			}
		});
	return [...new Set(cleaned)].slice(0, limit);
}

async function readWorkspaceCreationCapability(db: DbClient, userId: string): Promise<WorkspaceCreationCapability> {
	const meta = (
		await db.query<WorkspaceCapabilityRow>(
			`SELECT
			   (SELECT plan_id FROM user_settings WHERE user_id = $1 LIMIT 1) AS plan_id,
			   COUNT(*) AS workspace_count
			 FROM workspaces
			 WHERE user_id = $1`,
			[userId],
		)
	).rows[0];
	return workspaceCreationCapabilityFromRow(meta);
}

function workspaceCreationCapabilityFromRow(row: WorkspaceCapabilityRow | undefined): WorkspaceCreationCapability {
	return {
		canCreateWorkspace: canCreateWorkspaceForPlan(row?.plan_id ?? 'free', Number(row?.workspace_count ?? 0)),
	};
}

export async function workspaceCreationCapability(env: Env, userId: string): Promise<WorkspaceCreationCapability> {
	return withDbClient(env, (db) => readWorkspaceCreationCapability(db, userId));
}

export async function listWorkspaces(env: Env, userId: string): Promise<WorkspaceCatalogResult> {
	return withDbClient(env, async (db) => {
		const result = await db.query<WorkspaceCatalogRow>(
			`WITH meta AS (
				 SELECT
				   (SELECT plan_id FROM user_settings WHERE user_id = $1 LIMIT 1) AS plan_id,
				   (SELECT COUNT(*) FROM workspaces WHERE user_id = $1) AS workspace_count
			   ),
			   catalog AS (
				 SELECT w.id, w.title, w.description, w.updated_at, COUNT(d.id) AS document_count
				 FROM workspaces w
				 LEFT JOIN user_documents d ON d.workspace_id = w.id AND d.user_id = w.user_id
				 WHERE w.user_id = $1
				 GROUP BY w.id
				 ORDER BY w.updated_at DESC
				 LIMIT 50
			   )
			 SELECT meta.plan_id, meta.workspace_count, catalog.id, catalog.title, catalog.description, catalog.document_count
			 FROM meta
			 LEFT JOIN catalog ON true
			 ORDER BY catalog.updated_at DESC NULLS LAST`,
			[userId],
		);
		const capability = workspaceCreationCapabilityFromRow(result.rows[0]);
		return {
			canCreateWorkspace: capability.canCreateWorkspace,
			entries: result.rows
				.filter(
					(row): row is WorkspaceCatalogRow & { id: string; title: string; document_count: string | number } =>
						typeof row.id === 'string' && typeof row.title === 'string' && row.document_count != null,
				)
				.map((row) => ({
					id: row.id,
					title: row.title,
					description: row.description,
					documentCount: Number(row.document_count),
				})),
		};
	});
}

export async function addResource(
	env: Env,
	params: { userId: string; documentId: string; resourceIds?: string[]; urls?: string[] },
): Promise<AddDocumentResourceResult> {
	if (!isUuid(params.documentId)) throw new Error('Invalid documentId');
	const resourceIds = [...new Set((params.resourceIds ?? []).filter(isUuid))].slice(0, 20);
	const urls = cleanHttpUrls(params.urls ?? []);
	if (resourceIds.length === 0 && urls.length === 0) {
		return { linked: 0, created: 0, duplicates: 0, missing: 0, ingested: 0 };
	}

	const workspaceId = await getDocumentWorkspaceId(env, params.userId, params.documentId);
	const idResult = resourceIds.length
		? await withDbClient(env, (db) => addResourceIds(db, params.userId, workspaceId, resourceIds))
		: { created: 0, duplicates: 0, missing: 0 };
	const urlResult = urls.length ? await addDocumentResourceUrls(env, params.userId, workspaceId, urls) : { ingested: 0, ingestFailed: [] };
	return {
		linked: idResult.created + idResult.duplicates + urlResult.ingested,
		created: idResult.created,
		duplicates: idResult.duplicates,
		missing: idResult.missing,
		ingested: urlResult.ingested,
		...(urlResult.ingestFailed.length ? { ingestFailed: urlResult.ingestFailed } : {}),
	};
}

// better-auth user ids are 32-char alphanumeric, not UUIDs; ownership is enforced in resourceSourceExists
function hasValidResourceSourceId(source: ResourceSource): boolean {
	return source.type === 'user' || isUuid(source.id);
}

export async function addResourceToSource(
	env: Env,
	params: { userId: string; sourceType: ResourceSourceType; sourceId: string; targetType: ResourceTargetType; targetId: string },
): Promise<AddResourceToSourceResult> {
	const source = { type: params.sourceType, id: params.sourceId };
	const target = { type: params.targetType, id: params.targetId };
	if (!hasValidResourceSourceId(source) || !isUuid(params.targetId)) throw new Error('Resource not found');

	return withDbClient(env, async (db) => {
		const [sourceExists, targetExists] = await Promise.all([
			resourceSourceExists(db, params.userId, source),
			resourceTargetExists(db, params.userId, target),
		]);
		if (!sourceExists || !targetExists) throw new Error('Resource not found');

		const inserted = (
			await db.query<{ id: string; created_at: Date | string }>(
				`INSERT INTO citations (user_id, from_id, from_type, to_type, to_id)
				 VALUES ($1, $2, $3, $4, $5)
				 ON CONFLICT (from_type, from_id, to_type, to_id) DO NOTHING
				 RETURNING id, created_at`,
				[params.userId, source.id, source.type, target.type, target.id],
			)
		).rows[0];
		if (inserted) return { citationId: inserted.id, createdAt: dateIso(inserted.created_at), created: true };

		const existing = (
			await db.query<{ id: string; created_at: Date | string }>(
				`SELECT id, created_at
				 FROM citations
				 WHERE user_id = $1 AND from_type = $3 AND from_id = $2 AND to_type = $4 AND to_id = $5
				 LIMIT 1`,
				[params.userId, source.id, source.type, target.type, target.id],
			)
		).rows[0];
		if (!existing) throw new Error('Resource not found');
		return { citationId: existing.id, createdAt: dateIso(existing.created_at), created: false };
	});
}

export async function deleteResource(env: Env, params: { userId: string; citationId: string }): Promise<RemoveResourceResult> {
	if (!isUuid(params.citationId)) throw new Error('Resource not found');
	return withDbClient(env, async (db) => {
		const row = (
			await db.query<{ id: string }>('DELETE FROM citations WHERE id = $1 AND user_id = $2 RETURNING id', [
				params.citationId,
				params.userId,
			])
		).rows[0];
		if (!row) throw new Error('Resource not found');
		return { id: row.id };
	});
}

export async function removeResourceFromSource(
	env: Env,
	params: { userId: string; sourceType: ResourceSourceType; sourceId: string; targetType: ResourceTargetType; targetId: string },
): Promise<RemoveResourceResult> {
	if (!hasValidResourceSourceId({ type: params.sourceType, id: params.sourceId }) || !isUuid(params.targetId))
		throw new Error('Resource not found');
	return withDbClient(env, async (db) => {
		const row = (
			await db.query<{ to_id: string }>(
				`DELETE FROM citations
				 WHERE user_id = $1
				   AND from_type = $2
				   AND from_id = $3
				   AND to_type = $4
				   AND to_id = $5
				RETURNING to_id`,
				[params.userId, params.sourceType, params.sourceId, params.targetType, params.targetId],
			)
		).rows[0];
		if (!row) throw new Error('Resource not found');
		return { id: row.to_id };
	});
}

export async function validateResourceSource(
	env: Env,
	params: { userId: string; sourceType: ResourceSourceType; sourceId: string },
): Promise<ValidateResourceSourceResult> {
	const source = { type: params.sourceType, id: params.sourceId };
	await assertResourceSourceAccess(env, params.userId, source);
	return { sourceId: source.id, sourceType: source.type };
}

export async function addResourceUrlsToSource(
	env: Env,
	params: { userId: string; sourceType: ResourceSourceType; sourceId: string; urls: string[] },
): Promise<AddResourceUrlsToSourceResult> {
	const source = { type: params.sourceType, id: params.sourceId };
	const urls = cleanHttpUrls(params.urls);
	if (urls.length === 0) throw new Error('Add at least one valid URL');
	await assertResourceSourceAccess(env, params.userId, source);

	const ingested = await ingestUrls(env, { urls, userId: params.userId });
	if (!ingested.ok) throw new Error(ingested.message);
	const successfulIds = [...new Set(ingested.results.map((result) => result.userFileId).filter((id): id is string => !!id && isUuid(id)))];
	const citationIdsByUserFileId = successfulIds.length
		? await withDbClient(env, (db) => linkUserFilesToSource(db, params.userId, source, successfulIds))
		: new Map<string, string>();

	return {
		results: ingested.results.map((result) => ({
			url: result.url,
			userFileId: result.userFileId,
			citationId: result.userFileId ? citationIdsByUserFileId.get(result.userFileId) : undefined,
			instanceId: result.instanceId,
			resourceKind: result.resourceKind,
			originType: result.userFileId ? 'saved_url' : undefined,
			platformType: result.platformType,
			title: result.title,
			alreadyExists: !!result.alreadyExists,
			error: result.error,
		})),
	};
}

async function assertResourceSourceAccess(env: Env, userId: string, source: ResourceSource): Promise<void> {
	if (!hasValidResourceSourceId(source)) throw new Error('Source not found');
	const sourceRow = await withDbClient(env, async (db) => {
		return resourceSourceExists(db, userId, source);
	});
	if (!sourceRow) throw new Error('Source not found');
}

async function resourceSourceExists(db: DbClient, userId: string, source: ResourceSource): Promise<boolean> {
	if (source.type === 'user') {
		if (source.id !== userId) return false;
		const row = (await db.query<{ id: string }>('SELECT id FROM "user" WHERE id = $1 LIMIT 1', [userId])).rows[0];
		return !!row;
	}
	const table = source.type === 'workspace' ? 'workspaces' : 'collections';
	const row = (await db.query<{ id: string }>(`SELECT id FROM ${table} WHERE id = $1 AND user_id = $2 LIMIT 1`, [source.id, userId]))
		.rows[0];
	return !!row;
}

async function resourceTargetExists(db: DbClient, userId: string, target: ResourceTarget): Promise<boolean> {
	if (target.type === 'article') {
		const row = (await db.query<{ id: string }>('SELECT id FROM articles WHERE id = $1 LIMIT 1', [target.id])).rows[0];
		return !!row;
	}
	if (target.type === 'user_file') {
		const row = (await db.query<{ id: string }>('SELECT id FROM user_files WHERE id = $1 AND user_id = $2 LIMIT 1', [target.id, userId]))
			.rows[0];
		return !!row;
	}
	if (target.type === 'document') {
		const row = (
			await db.query<{ id: string }>('SELECT id FROM user_documents WHERE id = $1 AND (user_id = $2 OR share_enabled = true) LIMIT 1', [
				target.id,
				userId,
			])
		).rows[0];
		return !!row;
	}
	const row = (await db.query<{ id: string }>('SELECT id FROM collections WHERE id = $1 AND user_id = $2 LIMIT 1', [target.id, userId]))
		.rows[0];
	return !!row;
}

async function getDocumentWorkspaceId(env: Env, userId: string, documentId: string): Promise<string> {
	return withDbClient(env, async (db) => {
		const document = (
			await db.query<{ workspace_id: string }>(`SELECT workspace_id FROM user_documents WHERE id = $1 AND user_id = $2 LIMIT 1`, [
				documentId,
				userId,
			])
		).rows[0];
		if (!document) throw new Error('Document not found');
		return document.workspace_id;
	});
}

async function addResourceIds(db: DbClient, userId: string, workspaceId: string, resourceIds: string[]) {
	const [articles, files] = await Promise.all([
		db.query<{ id: string }>(`SELECT id FROM articles WHERE id = ANY($1::uuid[])`, [resourceIds]),
		db.query<{ id: string }>(`SELECT id FROM user_files WHERE id = ANY($1::uuid[]) AND user_id = $2`, [resourceIds, userId]),
	]);
	const articleIds = new Set(articles.rows.map((row) => row.id));
	const userFileIds = new Set(files.rows.map((row) => row.id));
	const targets = resourceIds.flatMap((id) => {
		if (articleIds.has(id)) return [{ toType: 'article', toId: id }];
		if (userFileIds.has(id)) return [{ toType: 'user_file', toId: id }];
		return [];
	});
	if (targets.length === 0) return { created: 0, duplicates: 0, missing: resourceIds.length };

	const values: unknown[] = [];
	const rows = targets
		.map((target, index) => {
			const offset = index * 5;
			values.push(userId, workspaceId, target.toType, target.toId, 'workspace');
			return `($${offset + 1}, $${offset + 2}, $${offset + 5}, $${offset + 3}, $${offset + 4})`;
		})
		.join(', ');
	const inserted = await db.query(
		`INSERT INTO citations (user_id, from_id, from_type, to_type, to_id)
		 VALUES ${rows}
		 ON CONFLICT (from_type, from_id, to_type, to_id) DO NOTHING`,
		values,
	);
	return {
		created: inserted.rowCount ?? 0,
		duplicates: targets.length - (inserted.rowCount ?? 0),
		missing: resourceIds.length - targets.length,
	};
}

async function addDocumentResourceUrls(env: Env, userId: string, workspaceId: string, urls: string[]) {
	const ingested = await ingestUrls(env, { urls, userId });
	if (!ingested.ok) {
		return {
			ingested: 0,
			ingestFailed: urls.map((url) => ({ url, error: ingested.message })),
		};
	}
	const successfulIds = [...new Set(ingested.results.map((result) => result.userFileId).filter((id): id is string => !!id && isUuid(id)))];
	const failures = ingested.results
		.filter((result) => result.error || !result.userFileId)
		.map((result) => ({ url: result.url, error: result.error ?? 'URL ingest did not return a user file id' }));
	if (successfulIds.length === 0) return { ingested: 0, ingestFailed: failures };

	await withDbClient(env, (db) => linkUserFilesToSource(db, userId, { type: 'workspace', id: workspaceId }, successfulIds));
	return { ingested: successfulIds.length, ingestFailed: failures };
}

async function linkUserFilesToSource(
	db: DbClient,
	userId: string,
	source: ResourceSource,
	userFileIds: string[],
): Promise<Map<string, string>> {
	const values: unknown[] = [];
	const rows = userFileIds
		.map((userFileId, index) => {
			const offset = index * 5;
			values.push(userId, source.id, source.type, 'user_file', userFileId);
			return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`;
		})
		.join(', ');
	await db.query(
		`INSERT INTO citations (user_id, from_id, from_type, to_type, to_id)
		 VALUES ${rows}
		 ON CONFLICT (from_type, from_id, to_type, to_id) DO NOTHING`,
		values,
	);
	const linked = await db.query<{ id: string; to_id: string }>(
		`SELECT id, to_id FROM citations
		 WHERE user_id = $1 AND from_id = $2 AND from_type = $3 AND to_type = 'user_file' AND to_id = ANY($4::uuid[])`,
		[userId, source.id, source.type, userFileIds],
	);
	return new Map(linked.rows.map((row) => [row.to_id, row.id]));
}
