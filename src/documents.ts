import { ingestUrls } from '@ingest/urls';
import type { DbClient } from '@shared/db';
import { withDbClient, withDbTransaction } from '@shared/db';
import type { Env } from '@shared/types';
import type { JSONContent } from '@tiptap/core';
import { Highlight } from '@tiptap/extension-highlight';
import { Image } from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TextAlign } from '@tiptap/extension-text-align';
import { Typography } from '@tiptap/extension-typography';
import { Underline } from '@tiptap/extension-underline';
import { MarkdownManager } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import type {
	AddDocumentResourceResult,
	CreateDocumentResult,
	DeleteDocumentResult,
	DocumentReadResult,
	EditDocumentResult,
	WorkspaceCatalogEntry,
	WorkspaceDecision,
} from '@worker-contracts/core-rpc';

const MAX_CONTEXT_DOCUMENTS = 8;
const MAX_CONTEXT_DOCUMENT_CHARS = 50_000;
const WORKSPACE_QUOTA_EXCEEDED_MESSAGE = 'Workspace quota exceeded.';
// Workspace creation quota is enforced here, inside the create-document
// transaction. Callers may hint the model, but they should not send plan state.
const PLAN_MAX_WORKSPACES: Record<string, number | null> = { free: 5, pro: null, test: null };

type DocumentEdit = { old_string: string; new_string: string };

type DocumentRow = {
	id: string;
	title: string;
	content: JSONContent | null;
	version: number;
	workspace_id: string;
	created_at: Date | string;
	updated_at: Date | string;
};
type ResourceSummaryRow = {
	id: string;
	title: string | null;
	title_cn: string | null;
	summary: string | null;
	summary_cn: string | null;
};

const markdownManager = new MarkdownManager({
	extensions: [
		StarterKit.configure({ link: { openOnClick: false, enableClickSelection: true } }),
		TextAlign.configure({ types: ['heading', 'paragraph'] }),
		TaskList,
		TaskItem.configure({ nested: true }),
		Highlight.configure({ multicolor: true }),
		Underline,
		Typography,
		Image,
	],
});

function markdownToTiptapJson(markdown: string): JSONContent {
	return markdownManager.parse(markdown);
}

function contentToMarkdown(content: JSONContent): string {
	return markdownManager.serialize(content);
}

function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function hasTransientImageSrc(node: unknown): boolean {
	if (Array.isArray(node)) return node.some(hasTransientImageSrc);
	if (!node || typeof node !== 'object') return false;
	const record = node as Record<string, unknown>;
	if (typeof record.src === 'string' && (record.src.startsWith('blob:') || record.src.startsWith('data:'))) return true;
	return Object.values(record).some(hasTransientImageSrc);
}

function dateIso(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function truncateContextDocument(markdown: string) {
	if (markdown.length <= MAX_CONTEXT_DOCUMENT_CHARS) return { content: markdown, truncated: false };
	return { content: markdown.slice(0, MAX_CONTEXT_DOCUMENT_CHARS), truncated: true };
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

function maxWorkspaces(planId: string): number | null {
	return PLAN_MAX_WORKSPACES[planId] ?? PLAN_MAX_WORKSPACES.free;
}

async function workspaceQuotaLimitTx(db: DbClient, userId: string): Promise<number | null> {
	await db.query('SELECT pg_advisory_xact_lock(581203, hashtext($1))', [userId]);
	const settings = await db.query<{ plan_id: string }>('SELECT plan_id FROM user_settings WHERE user_id = $1 LIMIT 1', [userId]);
	return maxWorkspaces(settings.rows[0]?.plan_id ?? 'free');
}

function applyMarkdownEdits(content: string, edits: DocumentEdit[]): { applied: number; failedAt?: string; result: string } {
	let current = content;
	let applied = 0;
	for (const edit of edits) {
		const first = current.indexOf(edit.old_string);
		if (first === -1) return { applied, failedAt: edit.old_string, result: current };
		if (current.indexOf(edit.old_string, first + edit.old_string.length) !== -1) {
			return { applied, failedAt: `[multiple matches] ${edit.old_string}`, result: current };
		}
		current = current.slice(0, first) + edit.new_string + current.slice(first + edit.old_string.length);
		applied += 1;
	}
	return { applied, result: current };
}

function documentContent(markdown: string): JSONContent {
	const content = markdownToTiptapJson(markdown);
	if (hasTransientImageSrc(content)) throw new Error('Images are still uploading');
	return content;
}

function resourceSummaryLine(
	citation: { to_id: string; to_type: string },
	articles: Map<string, ResourceSummaryRow>,
	files: Map<string, ResourceSummaryRow>,
): string | null {
	const resource =
		citation.to_type === 'article' ? articles.get(citation.to_id) : citation.to_type === 'user_file' ? files.get(citation.to_id) : null;
	if (!resource) return null;
	const title = resource.title_cn || resource.title || 'Untitled';
	const summary = resource.summary_cn || resource.summary;
	return `- ${title}${summary ? `: ${summary}` : ''}`;
}

export async function listWorkspaces(env: Env, userId: string): Promise<WorkspaceCatalogEntry[]> {
	return withDbClient(env, async (db) => {
		const result = await db.query<{
			id: string;
			title: string;
			description: string | null;
			document_count: string | number;
		}>(
			`SELECT w.id, w.title, w.description, COUNT(d.id) AS document_count
			 FROM workspaces w
			 LEFT JOIN user_documents d ON d.workspace_id = w.id AND d.user_id = w.user_id
			 WHERE w.user_id = $1
			 GROUP BY w.id
			 ORDER BY w.updated_at DESC
			 LIMIT 50`,
			[userId],
		);
		return result.rows.map((row) => ({
			id: row.id,
			title: row.title,
			description: row.description,
			documentCount: Number(row.document_count),
		}));
	});
}

export async function workspaceSummary(env: Env, userId: string, workspaceId: string): Promise<string | null> {
	if (!isUuid(workspaceId)) return null;
	return withDbClient(env, async (db) => {
		const workspace = (
			await db.query<{ id: string; title: string; description: string | null }>(
				`SELECT id, title, description FROM workspaces WHERE id = $1 AND user_id = $2 LIMIT 1`,
				[workspaceId, userId],
			)
		).rows[0];
		if (!workspace) return null;

		const citations = await db.query<{ to_id: string; to_type: string }>(
			`SELECT to_id, to_type
			 FROM citations
			 WHERE from_id = $1 AND from_type = 'workspace' AND user_id = $2
			 ORDER BY created_at DESC
			 LIMIT 12`,
			[workspace.id, userId],
		);
		const articleIds = citations.rows.filter((row) => row.to_type === 'article' && isUuid(row.to_id)).map((row) => row.to_id);
		const userFileIds = citations.rows.filter((row) => row.to_type === 'user_file' && isUuid(row.to_id)).map((row) => row.to_id);
		const [articles, files] = await Promise.all([
			articleIds.length
				? db.query<ResourceSummaryRow>(`SELECT id, title, title_cn, summary, summary_cn FROM articles WHERE id = ANY($1::uuid[])`, [
						articleIds,
					])
				: Promise.resolve({
						rows: [] as ResourceSummaryRow[],
					}),
			userFileIds.length
				? db.query<ResourceSummaryRow>(
						`SELECT id, title, title_cn, summary, summary_cn FROM user_files WHERE id = ANY($1::uuid[]) AND user_id = $2`,
						[userFileIds, userId],
					)
				: Promise.resolve({
						rows: [] as ResourceSummaryRow[],
					}),
		]);
		const articleById = new Map(articles.rows.map((row) => [row.id, row]));
		const fileById = new Map(files.rows.map((row) => [row.id, row]));
		const resources = citations.rows
			.map((citation) => resourceSummaryLine(citation, articleById, fileById))
			.filter((line): line is string => !!line);

		return [
			`Workspace: ${workspace.title}`,
			workspace.description ? `Description: ${workspace.description}` : '',
			resources.length ? `Pinned resources:\n${resources.join('\n')}` : '',
		]
			.filter(Boolean)
			.join('\n\n');
	});
}

export async function createDocument(
	env: Env,
	params: { userId: string; title: string; markdown: string; workspace: WorkspaceDecision },
): Promise<CreateDocumentResult> {
	if (!params.markdown.trim()) throw new Error('Generated document content is empty');
	const content = documentContent(params.markdown);
	const normalizedTitle = params.title.trim().slice(0, 200) || 'Untitled';

	return withDbTransaction(env, 'create document', async (db) => {
		if (params.workspace.mode === 'existing') {
			if (!isUuid(params.workspace.workspaceId)) throw new Error('Workspace not found');
			const workspace = (
				await db.query<{ id: string; title: string }>(`SELECT id, title FROM workspaces WHERE id = $1 AND user_id = $2 LIMIT 1`, [
					params.workspace.workspaceId,
					params.userId,
				])
			).rows[0];
			if (!workspace) throw new Error('Workspace not found');
			const document = await insertDocument(db, {
				content,
				title: normalizedTitle,
				userId: params.userId,
				workspaceId: workspace.id,
			});
			return {
				documentId: document.id,
				workspaceId: document.workspace_id,
				workspaceTitle: workspace.title,
				workspaceCreated: false,
			};
		}

		const limit = await workspaceQuotaLimitTx(db, params.userId);
		if (limit !== null) {
			const count = Number((await db.query(`SELECT COUNT(*) FROM workspaces WHERE user_id = $1`, [params.userId])).rows[0]?.count ?? 0);
			if (count >= limit) throw new Error(WORKSPACE_QUOTA_EXCEEDED_MESSAGE);
		}

		const workspace = (
			await db.query<{ id: string; title: string }>(
				`INSERT INTO workspaces (user_id, title, description)
				 VALUES ($1, $2, $3)
				 RETURNING id, title`,
				[
					params.userId,
					params.workspace.title.trim().slice(0, 120) || 'Workspace',
					params.workspace.description?.trim().slice(0, 500) || null,
				],
			)
		).rows[0];
		if (!workspace) throw new Error('Workspace not created');
		const document = await insertDocument(db, {
			content,
			title: normalizedTitle,
			userId: params.userId,
			workspaceId: workspace.id,
		});
		return {
			documentId: document.id,
			workspaceId: document.workspace_id,
			workspaceTitle: workspace.title,
			workspaceCreated: true,
		};
	});
}

export async function deleteDocument(env: Env, params: { userId: string; documentId: string }): Promise<DeleteDocumentResult> {
	if (!isUuid(params.documentId)) throw new Error('Document not found');
	return withDbClient(env, async (db) => {
		const row = (
			await db.query<{ id: string }>(`DELETE FROM user_documents WHERE id = $1 AND user_id = $2 RETURNING id`, [
				params.documentId,
				params.userId,
			])
		).rows[0];
		if (!row) throw new Error('Document not found');
		return { id: row.id };
	});
}

async function insertDocument(
	db: DbClient,
	input: { userId: string; workspaceId: string; title: string; content: JSONContent },
): Promise<{ id: string; workspace_id: string }> {
	const row = (
		await db.query<{ id: string; workspace_id: string }>(
			`INSERT INTO user_documents (user_id, workspace_id, title, content, creation_mode, version)
			 VALUES ($1, $2, $3, $4::jsonb, 'generate', 1)
			 RETURNING id, workspace_id`,
			[input.userId, input.workspaceId, input.title, JSON.stringify(input.content)],
		)
	).rows[0];
	if (!row) throw new Error('Document not created');
	return row;
}

export async function readDocuments(env: Env, userId: string, ids: string[]): Promise<DocumentReadResult[]> {
	const requestedIds = [...new Set(ids)].slice(0, MAX_CONTEXT_DOCUMENTS);
	const validIds = requestedIds.filter(isUuid);
	if (validIds.length === 0) return requestedIds.map((id) => ({ type: 'error' as const, id, error: `Document not found: ${id}` }));
	return withDbClient(env, async (db) => {
		const rows = (
			await db.query<DocumentRow>(
				`SELECT id, title, content, version, workspace_id, created_at, updated_at
				 FROM user_documents
				 WHERE user_id = $1 AND id = ANY($2::uuid[])`,
				[userId, validIds],
			)
		).rows;
		const byId = new Map(rows.map((row) => [row.id, row]));
		return requestedIds.map((id) => {
			const row = byId.get(id);
			if (!row) return { type: 'error' as const, id, error: `Document not found: ${id}` };
			const { content, truncated } = truncateContextDocument(
				contentToMarkdown(row.content ?? { type: 'doc', content: [{ type: 'paragraph' }] }),
			);
			return {
				type: 'document' as const,
				id: row.id,
				title: row.title,
				content,
				metadata: {
					createdAt: dateIso(row.created_at),
					truncated,
					updatedAt: dateIso(row.updated_at),
					version: row.version,
				},
			};
		});
	});
}

export async function editDocument(
	env: Env,
	params: { userId: string; documentId: string; edits: DocumentEdit[]; snapshot?: boolean },
): Promise<EditDocumentResult> {
	if (!isUuid(params.documentId)) throw new Error('Invalid documentId');
	if (params.edits.length === 0) throw new Error('At least one edit is required');
	return withDbTransaction(env, 'edit document', async (db) => {
		const document = (
			await db.query<DocumentRow>(
				`SELECT id, title, content, version, workspace_id, created_at, updated_at
				 FROM user_documents
				 WHERE id = $1 AND user_id = $2
				 LIMIT 1`,
				[params.documentId, params.userId],
			)
		).rows[0];
		if (!document) throw new Error('Document not found');

		const markdown = contentToMarkdown(document.content ?? { type: 'doc', content: [{ type: 'paragraph' }] });
		const { applied, failedAt, result } = applyMarkdownEdits(markdown, params.edits);
		if (failedAt !== undefined) throw new Error(`Text to replace not found: "${failedAt.slice(0, 80)}"`);

		const content = documentContent(result);
		const newVersion = document.version + 1;
		const updated = (
			await db.query<{ title: string; version: number }>(
				`UPDATE user_documents
				 SET content = $3::jsonb, version = $4, updated_at = NOW()
				 WHERE id = $1 AND user_id = $2
				 RETURNING title, version`,
				[document.id, params.userId, JSON.stringify(content), newVersion],
			)
		).rows[0];
		if (!updated) throw new Error('Document not found');

		if (params.snapshot ?? true) {
			await createDocumentVersionSnapshot(db, {
				content: document.content ?? { type: 'doc', content: [{ type: 'paragraph' }] },
				documentId: document.id,
				title: document.title,
				version: document.version,
			});
		}

		return { editCount: applied, newMarkdown: result, newVersion: updated.version, title: updated.title };
	});
}

async function createDocumentVersionSnapshot(
	db: DbClient,
	input: { documentId: string; content: JSONContent; title: string; version: number },
): Promise<void> {
	const latest = (
		await db.query<{ content: JSONContent | null }>(
			`SELECT content FROM document_versions WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1`,
			[input.documentId],
		)
	).rows[0];
	if (latest && JSON.stringify(latest.content) === JSON.stringify(input.content)) return;
	await db.query(
		`INSERT INTO document_versions (document_id, content, title, version, source)
		 VALUES ($1, $2::jsonb, $3, $4, 'ai-edit')`,
		[input.documentId, JSON.stringify(input.content), input.title, input.version],
	);
}

export async function addResource(
	env: Env,
	params: { userId: string; documentId: string; resourceIds?: string[]; urls?: string[] },
): Promise<AddDocumentResourceResult> {
	if (!isUuid(params.documentId)) throw new Error('Invalid documentId');
	const resourceIds = [...new Set((params.resourceIds ?? []).filter(isUuid))].slice(0, 20);
	const urls = cleanHttpUrls(params.urls ?? []);
	if (resourceIds.length === 0 && urls.length === 0) throw new Error('Provide at least one resource id or URL');

	const workspaceId = await getDocumentWorkspaceId(env, params.userId, params.documentId);
	const idResult = resourceIds.length
		? await withDbClient(env, (db) => addResourceIds(db, params.userId, workspaceId, resourceIds))
		: { created: 0, duplicates: 0, missing: 0 };
	const urlResult = urls.length ? await addResourceUrls(env, params.userId, workspaceId, urls) : { ingested: 0, ingestFailed: [] };
	return {
		linked: idResult.created + idResult.duplicates + urlResult.ingested,
		created: idResult.created,
		duplicates: idResult.duplicates,
		missing: idResult.missing,
		ingested: urlResult.ingested,
		...(urlResult.ingestFailed.length ? { ingestFailed: urlResult.ingestFailed } : {}),
	};
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

async function addResourceUrls(env: Env, userId: string, workspaceId: string, urls: string[]) {
	const ingested = await ingestUrls(env, { urls, userId });
	if (!ingested.ok) throw new Error(ingested.message);
	const successfulIds = [...new Set(ingested.results.map((result) => result.userFileId).filter((id): id is string => !!id && isUuid(id)))];
	const failures = ingested.results
		.filter((result) => result.error || !result.userFileId)
		.map((result) => ({ url: result.url, error: result.error ?? 'URL ingest did not return a user file id' }));
	if (successfulIds.length === 0) return { ingested: 0, ingestFailed: failures };

	await withDbClient(env, (db) => linkUserFilesToWorkspace(db, userId, workspaceId, successfulIds));
	return { ingested: successfulIds.length, ingestFailed: failures };
}

async function linkUserFilesToWorkspace(db: DbClient, userId: string, workspaceId: string, userFileIds: string[]): Promise<void> {
	const values: unknown[] = [];
	const rows = userFileIds
		.map((userFileId, index) => {
			const offset = index * 5;
			values.push(userId, workspaceId, 'workspace', 'user_file', userFileId);
			return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`;
		})
		.join(', ');
	await db.query(
		`INSERT INTO citations (user_id, from_id, from_type, to_type, to_id)
		 VALUES ${rows}
		 ON CONFLICT (from_type, from_id, to_type, to_id) DO NOTHING`,
		values,
	);
}
