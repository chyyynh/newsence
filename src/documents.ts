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
	AddResourceToSourceResult,
	AddResourceUrlsToSourceResult,
	CreateDocumentResult,
	CreateWorkspaceResult,
	DeleteDocumentResult,
	DocumentReadResult,
	DocumentSnapshotSource,
	EditDocumentResult,
	RemoveResourceResult,
	ResourceSourceType,
	ResourceTargetType,
	SaveDocumentResult,
	UpdateDocumentShareResult,
	ValidateResourceSourceResult,
	WorkspaceCatalogEntry,
	WorkspaceDecision,
	WorkspaceDocumentResult,
} from '@worker-contracts/core-rpc';

const MAX_CONTEXT_DOCUMENTS = 8;
const MAX_CONTEXT_DOCUMENT_CHARS = 50_000;
export const WORKSPACE_QUOTA_EXCEEDED_MESSAGE = 'Workspace quota exceeded.';
// Workspace creation quota is enforced here, inside the create-document
// transaction. Callers may hint the model, but they should not send plan state.
const PLAN_MAX_WORKSPACES: Record<string, number | null> = { free: 5, pro: null, test: null };
const SNAPSHOT_THROTTLE_MS = 10 * 60 * 1000;
const EMPTY_TIPTAP_DOCUMENT = { type: 'doc', content: [{ type: 'paragraph' }] } satisfies JSONContent;
const SHARE_SLUG_FORMAT = /^(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

type DocumentEdit = { old_string: string; new_string: string };
type ResourceSource = { type: ResourceSourceType; id: string };
type ResourceTarget = { type: ResourceTargetType; id: string };

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
type WorkspaceDocumentRow = {
	id: string;
	workspace_id: string | null;
	title: string;
	description: string | null;
	content: JSONContent | null;
	version: number;
	share_enabled: boolean;
	share_slug: string | null;
	username: string | null;
	updated_at: Date | string;
};
type DocumentShareRow = {
	id: string;
	title: string;
	share_slug: string | null;
	published_at: Date | string | null;
	username: string | null;
};
type DocumentShareUpdateRow = {
	id: string;
	share_enabled: boolean;
	share_slug: string | null;
	description: string | null;
	published_at: Date | string | null;
	updated_at: Date | string;
	username: string | null;
};
type SaveDocumentRow = {
	id: string;
	title: string;
	content: JSONContent | null;
	version: number;
	updated_at: Date | string;
};

export class DocumentVersionConflictError extends Error {
	constructor(
		readonly serverVersion: number,
		readonly clientVersion: number,
	) {
		super('Document version conflict');
		this.name = 'DocumentVersionConflictError';
	}
}

export class DocumentEmptyContentBlockedError extends Error {
	constructor() {
		super('Empty document content was blocked');
		this.name = 'DocumentEmptyContentBlockedError';
	}
}

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

function contentHasMeaningfulNode(nodes: JSONContent[] | undefined): boolean {
	return !!nodes?.some((node) => {
		if (typeof node.text === 'string' && node.text.trim()) return true;
		if (node.type && !['doc', 'paragraph', 'hardBreak', 'text'].includes(node.type)) return true;
		return contentHasMeaningfulNode(node.content);
	});
}

function isEmptyEditorContent(content: unknown): boolean {
	if (content === null || content === undefined) return true;
	return !contentHasMeaningfulNode((content as JSONContent).content);
}

function dateIso(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function truncateContextDocument(markdown: string) {
	if (markdown.length <= MAX_CONTEXT_DOCUMENT_CHARS) return { content: markdown, truncated: false };
	return { content: markdown.slice(0, MAX_CONTEXT_DOCUMENT_CHARS), truncated: true };
}

function serializeWorkspaceDocument(row: WorkspaceDocumentRow): WorkspaceDocumentResult {
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		title: row.title,
		description: row.description,
		content: (row.content ?? EMPTY_TIPTAP_DOCUMENT) as WorkspaceDocumentResult['content'],
		version: row.version,
		shareEnabled: row.share_enabled,
		shareSlug: row.share_slug,
		username: row.username,
		updatedAt: dateIso(row.updated_at),
	};
}

function serializeDocumentShareUpdate(row: DocumentShareUpdateRow): UpdateDocumentShareResult {
	return {
		id: row.id,
		shareEnabled: row.share_enabled,
		shareSlug: row.share_slug,
		description: row.description,
		publishedAt: row.published_at ? dateIso(row.published_at) : null,
		updatedAt: dateIso(row.updated_at),
		username: row.username,
	};
}

function serializeSaveDocument(row: SaveDocumentRow): SaveDocumentResult {
	return {
		id: row.id,
		title: row.title,
		content: (row.content ?? EMPTY_TIPTAP_DOCUMENT) as SaveDocumentResult['content'],
		version: row.version,
		updatedAt: dateIso(row.updated_at),
	};
}

function sameJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function generateShareSlugFromTitle(title: string): string {
	const trimmed = title.trim();
	if (!trimmed) return 'untitled';
	const slug = trimmed
		.toLowerCase()
		.replace(/[^\w\s-]/g, '')
		.replace(/[_\s]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 100);
	return slug.length >= 3 ? slug : `article-${Date.now()}`;
}

async function generateUniqueShareSlugTx(db: DbClient, title: string, userId: string): Promise<string> {
	await db.query('SELECT pg_advisory_xact_lock(823947, hashtext($1))', [userId]);
	const baseSlug = generateShareSlugFromTitle(title);
	for (let index = 1; index <= 100; index += 1) {
		const slug = index === 1 ? baseSlug : `${baseSlug}-${index}`;
		const taken = (
			await db.query<{ id: string }>('SELECT id FROM user_documents WHERE user_id = $1 AND share_slug = $2 LIMIT 1', [userId, slug])
		).rows[0];
		if (!taken) return slug;
	}
	return `${baseSlug}-${Date.now()}`;
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

export async function createWorkspace(
	env: Env,
	params: { userId: string; title: string; description?: string | null },
): Promise<CreateWorkspaceResult> {
	return withDbTransaction(env, 'create workspace', async (db) => {
		const limit = await workspaceQuotaLimitTx(db, params.userId);
		if (limit !== null) {
			const count = Number((await db.query('SELECT COUNT(*) FROM workspaces WHERE user_id = $1', [params.userId])).rows[0]?.count ?? 0);
			if (count >= limit) throw new Error(WORKSPACE_QUOTA_EXCEEDED_MESSAGE);
		}

		const workspace = (
			await db.query<{ id: string }>(
				`INSERT INTO workspaces (user_id, title, description)
				 VALUES ($1, $2, $3)
				 RETURNING id`,
				[params.userId, params.title.trim().slice(0, 120) || 'Workspace', params.description?.trim().slice(0, 500) || null],
			)
		).rows[0];
		if (!workspace) throw new Error('Workspace not created');
		return { id: workspace.id };
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

export async function createWorkspaceDocument(
	env: Env,
	params: { userId: string; workspaceId: string; title?: string },
): Promise<WorkspaceDocumentResult> {
	if (!isUuid(params.workspaceId)) throw new Error('Workspace not found');
	const title = params.title?.trim().slice(0, 200) || 'Untitled';
	const content = JSON.stringify(EMPTY_TIPTAP_DOCUMENT);

	return withDbClient(env, async (db) => {
		const row = (
			await db.query<WorkspaceDocumentRow>(
				`WITH workspace AS (
				   SELECT id FROM workspaces WHERE id = $1 AND user_id = $2 LIMIT 1
				 ), inserted AS (
				   INSERT INTO user_documents (user_id, workspace_id, title, content)
				   SELECT $2, id, $3, $4::jsonb FROM workspace
				   RETURNING id, workspace_id, title, description, content, version, share_enabled, share_slug, updated_at, user_id
				 ), touched AS (
				   UPDATE workspaces w
				      SET updated_at = NOW()
				     FROM inserted
				    WHERE w.id = inserted.workspace_id AND w.user_id = $2
				RETURNING w.id
				 )
				 SELECT inserted.id, inserted.workspace_id, inserted.title, inserted.description, inserted.content,
				        inserted.version, inserted.share_enabled, inserted.share_slug, inserted.updated_at, u.username
				   FROM inserted
				   LEFT JOIN touched t ON t.id = inserted.workspace_id
				   LEFT JOIN "user" u ON u.id = inserted.user_id`,
				[params.workspaceId, params.userId, title, content],
			)
		).rows[0];
		if (!row) throw new Error('Workspace not found');
		return serializeWorkspaceDocument(row);
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

export async function saveDocument(
	env: Env,
	params: {
		userId: string;
		documentId: string;
		title: string;
		content: SaveDocumentResult['content'];
		allowEmptyContentOverwrite?: boolean;
		expectedVersion?: number;
		source?: DocumentSnapshotSource;
		forceSnapshot?: boolean;
	},
): Promise<SaveDocumentResult> {
	if (!isUuid(params.documentId)) throw new Error('Document not found');
	return withDbTransaction(env, 'save document', async (db) => {
		const existing = (
			await db.query<DocumentRow>(
				`SELECT id, title, content, version, workspace_id, created_at, updated_at
				 FROM user_documents
				 WHERE id = $1 AND user_id = $2
				 LIMIT 1`,
				[params.documentId, params.userId],
			)
		).rows[0];
		if (!existing) throw new Error('Document not found');
		if (params.expectedVersion !== undefined && params.expectedVersion !== existing.version) {
			throw new DocumentVersionConflictError(existing.version, params.expectedVersion);
		}

		const incomingContent = params.content as JSONContent;
		const incomingEmpty = isEmptyEditorContent(incomingContent);
		const existingHasContent = !isEmptyEditorContent(existing.content);
		if (hasTransientImageSrc(incomingContent)) throw new Error('Images are still uploading');
		if (incomingEmpty && existingHasContent && params.allowEmptyContentOverwrite !== true) {
			throw new DocumentEmptyContentBlockedError();
		}

		const contentChanged = !sameJson(existing.content, incomingContent);
		const updated = (
			await db.query<SaveDocumentRow>(
				`UPDATE user_documents
				 SET title = $3,
				     content = $4::jsonb,
				     version = CASE WHEN $5 THEN version + 1 ELSE version END,
				     updated_at = NOW()
				 WHERE id = $1 AND user_id = $2
				 RETURNING id, title, content, version, updated_at`,
				[existing.id, params.userId, params.title.trim().slice(0, 200) || 'Untitled', JSON.stringify(incomingContent), contentChanged],
			)
		).rows[0];
		if (!updated) throw new Error('Document not found');

		const source = params.source ?? 'auto-save';
		if (contentChanged || params.forceSnapshot) {
			await createDocumentVersionSnapshot(
				db,
				{
					content: existing.content ?? EMPTY_TIPTAP_DOCUMENT,
					documentId: existing.id,
					source,
					title: existing.title,
					version: existing.version,
				},
				source === 'auto-save' && !params.forceSnapshot ? { minIntervalMs: SNAPSHOT_THROTTLE_MS } : undefined,
			);
		}

		return serializeSaveDocument(updated);
	});
}

export async function updateDocumentShare(
	env: Env,
	params: { userId: string; documentId: string; shareEnabled: boolean; shareSlug?: string | null; description?: string | null },
): Promise<UpdateDocumentShareResult> {
	if (!isUuid(params.documentId)) throw new Error('Document not found');
	return withDbTransaction(env, 'update document share', async (db) => {
		const document = (
			await db.query<DocumentShareRow>(
				`SELECT d.id, d.title, d.share_slug, d.published_at, u.username
				   FROM user_documents d
				   LEFT JOIN "user" u ON u.id = d.user_id
				  WHERE d.id = $1 AND d.user_id = $2
				  LIMIT 1`,
				[params.documentId, params.userId],
			)
		).rows[0];
		if (!document) throw new Error('Document not found');
		if (params.shareEnabled && !document.username) throw new Error('Set a username before sharing.');

		let shareSlug = params.shareSlug?.trim() || document.share_slug;
		if (params.shareEnabled && !shareSlug) {
			shareSlug = await generateUniqueShareSlugTx(db, document.title, params.userId);
		}
		if (shareSlug && shareSlug !== document.share_slug && !SHARE_SLUG_FORMAT.test(shareSlug)) {
			throw new Error('Invalid share URL.');
		}
		if (shareSlug && shareSlug !== document.share_slug) {
			const existing = (
				await db.query<{ id: string }>('SELECT id FROM user_documents WHERE user_id = $1 AND share_slug = $2 AND id <> $3 LIMIT 1', [
					params.userId,
					shareSlug,
					params.documentId,
				])
			).rows[0];
			if (existing) throw new Error('This URL is already in use.');
		}

		const publishedAt = params.shareEnabled && !document.published_at ? new Date() : document.published_at;
		const updated = (
			await db.query<DocumentShareUpdateRow>(
				`UPDATE user_documents d
				    SET share_enabled = $3,
				        share_slug = $4,
				        description = $5,
				        published_at = $6,
				        updated_at = now()
				   FROM "user" u
				  WHERE d.id = $1 AND d.user_id = $2 AND u.id = d.user_id
				RETURNING d.id, d.share_enabled, d.share_slug, d.description, d.published_at, d.updated_at, u.username`,
				[params.documentId, params.userId, params.shareEnabled, shareSlug, params.description?.trim().slice(0, 300) || null, publishedAt],
			)
		).rows[0];
		if (!updated) throw new Error('Document not found');
		return serializeDocumentShareUpdate(updated);
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
	await db.query(`UPDATE workspaces SET updated_at = NOW() WHERE id = $1 AND user_id = $2`, [input.workspaceId, input.userId]);
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
				source: 'ai-edit',
				title: document.title,
				version: document.version,
			});
		}

		return { editCount: applied, newMarkdown: result, newVersion: updated.version, title: updated.title };
	});
}

async function createDocumentVersionSnapshot(
	db: DbClient,
	input: { documentId: string; content: JSONContent; title: string; version: number; source: DocumentSnapshotSource },
	options?: { minIntervalMs?: number },
): Promise<void> {
	const latest = (
		await db.query<{ content: JSONContent | null; created_at: Date | string }>(
			`SELECT content, created_at FROM document_versions WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1`,
			[input.documentId],
		)
	).rows[0];
	if (latest && sameJson(latest.content, input.content)) return;
	if (options?.minIntervalMs && latest?.created_at) {
		const elapsed = Date.now() - new Date(latest.created_at).getTime();
		if (elapsed < options.minIntervalMs) return;
	}
	await db.query(
		`INSERT INTO document_versions (document_id, content, title, version, source)
		 VALUES ($1, $2::jsonb, $3, $4, $5)`,
		[input.documentId, JSON.stringify(input.content), input.title, input.version, input.source],
	);
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
	if (!ingested.ok) throw new Error(ingested.message);
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
