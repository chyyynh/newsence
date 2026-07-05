import type { DbClient } from '@shared/db';
import { withDbClient } from '@shared/db';
import type { Env } from '@shared/types';
import type { JSONContent } from '@tiptap/core';
import { contentToMarkdown } from '@worker-contracts/editor-markdown';
import type {
	PodcastContextSource,
	PodcastLanguage,
	PodcastScript,
	PodcastSpeaker,
	PodcastStatus,
	PodcastSummary,
	WorkspacePodcastContextResult,
} from '@worker-contracts/podcast-contracts';

const MAX_CONTEXT_SOURCES = 24;
const MAX_CONTEXT_DOCUMENTS = 10;
const MAX_SOURCE_CHARS = 6000;
const MAX_CONTEXT_CHARS = 80_000;

type PodcastRow = {
	id: string;
	workspace_id: string;
	title: string;
	status: string;
	audio_url: string | null;
	duration_sec: number | null;
	lang: string;
	error: string | null;
	workflow_run_id?: string | null;
	created_at: Date | string;
	updated_at: Date | string;
	script?: unknown;
};

type WorkspaceRow = { id: string; title: string; description: string | null };
type DocumentRow = { id: string; title: string; description: string | null; content: JSONContent | null; updated_at: Date | string };
type CitationRow = { to_type: string; to_id: string; from_id?: string; created_at?: Date | string };
type ArticleRow = {
	id: string;
	title: string | null;
	title_cn: string | null;
	url: string | null;
	source: string | null;
	summary: string | null;
	summary_cn: string | null;
	content: string | null;
	content_cn: string | null;
};
type UserFileRow = {
	id: string;
	file_name: string;
	title: string | null;
	title_cn: string | null;
	source_url: string | null;
	site_name: string | null;
	summary: string | null;
	summary_cn: string | null;
	extracted_text: string | null;
	content_cn: string | null;
};
type CollectionRow = { id: string; name: string; description: string | null; article_count: number };

class PodcastNotFoundError extends Error {
	constructor() {
		super('Podcast not found');
		this.name = 'PodcastNotFoundError';
	}
}

class PodcastNotReadyError extends Error {
	constructor() {
		super('Podcast is not ready for synthesis');
		this.name = 'PodcastNotReadyError';
	}
}

function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function dateIso(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parsePodcastStatus(value: string): PodcastStatus {
	if (value === 'pending' || value === 'scripting' || value === 'synthesizing' || value === 'complete' || value === 'failed') return value;
	return 'failed';
}

function parsePodcastLanguage(value: string): PodcastLanguage {
	return value === 'en' ? 'en' : 'zh-TW';
}

function parsePodcastSpeaker(value: unknown): PodcastSpeaker {
	if (value === 'host_a' || value === 'host_b') return value;
	throw new Error('Invalid podcast speaker');
}

function parsePodcastScript(value: unknown): PodcastScript {
	if (!value || typeof value !== 'object') throw new Error('Invalid podcast script');
	const record = value as Record<string, unknown>;
	const lines = Array.isArray(record.lines) ? record.lines : null;
	if (!lines || lines.length < 6 || lines.length > 80) throw new Error('Invalid podcast script lines');
	return {
		scratchpad: typeof record.scratchpad === 'string' ? record.scratchpad.trim() : '',
		lines: lines.map((line) => {
			if (!line || typeof line !== 'object') throw new Error('Invalid podcast script line');
			const lineRecord = line as Record<string, unknown>;
			const text = typeof lineRecord.text === 'string' ? lineRecord.text.trim() : '';
			if (!text) throw new Error('Podcast script line cannot be empty');
			return {
				speaker: parsePodcastSpeaker(lineRecord.speaker),
				text,
			};
		}),
	};
}

function podcastSummary(row: PodcastRow): PodcastSummary {
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		title: row.title,
		status: parsePodcastStatus(row.status),
		lang: parsePodcastLanguage(row.lang),
		audioUrl: row.audio_url,
		durationSec: row.duration_sec,
		error: row.error,
		createdAt: dateIso(row.created_at),
		updatedAt: dateIso(row.updated_at),
	};
}

function compact(value: string | null | undefined): string {
	return value?.replace(/\s+/g, ' ').trim() ?? '';
}

function truncate(value: string, max = MAX_SOURCE_CHARS): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max).trimEnd()}\n\n[truncated]`;
}

function sourceBlock(source: PodcastContextSource): string {
	const lines = [
		`### ${source.title}`,
		`Type: ${source.type}`,
		source.source ? `Source: ${source.source}` : '',
		source.url ? `URL: ${source.url}` : '',
		'',
		source.content,
	];
	return lines.filter(Boolean).join('\n');
}

function buildContextMarkdown(workspace: WorkspaceRow, sources: PodcastContextSource[]): string {
	const header = [`# Workspace: ${workspace.title}`, workspace.description ? `Description: ${workspace.description}` : '']
		.filter(Boolean)
		.join('\n');
	const body = sources.map(sourceBlock).join('\n\n');
	return truncate([header, body].filter(Boolean).join('\n\n'), MAX_CONTEXT_CHARS);
}

function articleSource(row: ArticleRow): PodcastContextSource {
	const title = compact(row.title_cn) || compact(row.title) || 'Untitled article';
	const summary = [compact(row.summary_cn), compact(row.summary)].filter(Boolean).join('\n');
	const content = [summary, compact(row.content_cn), compact(row.content)].filter(Boolean).join('\n\n');
	return {
		id: row.id,
		type: 'article',
		title,
		url: row.url,
		source: row.source,
		content: truncate(content || title),
	};
}

function userFileSource(row: UserFileRow): PodcastContextSource {
	const title = compact(row.title_cn) || compact(row.title) || compact(row.file_name) || 'Untitled file';
	const summary = [compact(row.summary_cn), compact(row.summary)].filter(Boolean).join('\n');
	const content = [summary, compact(row.content_cn), compact(row.extracted_text)].filter(Boolean).join('\n\n');
	return {
		id: row.id,
		type: 'user_file',
		title,
		url: row.source_url,
		source: row.site_name,
		content: truncate(content || title),
	};
}

function documentSource(row: DocumentRow): PodcastContextSource {
	const markdown = contentToMarkdown(row.content ?? { type: 'doc', content: [{ type: 'paragraph' }] });
	return {
		id: row.id,
		type: 'document',
		title: compact(row.title) || 'Untitled document',
		content: truncate([compact(row.description), markdown].filter(Boolean).join('\n\n') || row.title),
	};
}

function collectionSource(row: CollectionRow): PodcastContextSource {
	return {
		id: row.id,
		type: 'collection',
		title: row.name,
		content: truncate([row.description, `${row.article_count} articles`].filter(Boolean).join('\n')),
	};
}

async function assertWorkspace(db: DbClient, userId: string, workspaceId: string): Promise<WorkspaceRow> {
	if (!isUuid(workspaceId)) throw new Error('Workspace not found');
	const row = (
		await db.query<WorkspaceRow>('SELECT id, title, description FROM workspaces WHERE id = $1 AND user_id = $2 LIMIT 1', [
			workspaceId,
			userId,
		])
	).rows[0];
	if (!row) throw new Error('Workspace not found');
	return row;
}

export async function createPodcast(
	env: Env,
	input: { userId: string; workspaceId: string; lang: PodcastLanguage; title?: string },
): Promise<PodcastSummary> {
	return withDbClient(env, async (db) => {
		const workspace = await assertWorkspace(db, input.userId, input.workspaceId);
		const title = input.title?.trim().slice(0, 200) || `${workspace.title} Audio Overview`;
		const row = (
			await db.query<PodcastRow>(
				`INSERT INTO user_podcasts (user_id, workspace_id, title, status, lang)
				 VALUES ($1, $2, $3, 'scripting', $4)
				 RETURNING id, workspace_id, title, status, audio_url, duration_sec, lang, error, created_at, updated_at`,
				[input.userId, input.workspaceId, title, input.lang],
			)
		).rows[0];
		return podcastSummary(row);
	});
}

function addTarget(targets: CitationRow[], seen: Set<string>, row: CitationRow) {
	if (!isUuid(row.to_id)) return;
	if (row.to_type !== 'article' && row.to_type !== 'user_file' && row.to_type !== 'document' && row.to_type !== 'collection') return;
	const key = `${row.to_type}:${row.to_id}`;
	if (seen.has(key)) return;
	seen.add(key);
	targets.push(row);
}

async function collectionMemberTargets(db: DbClient, userId: string, collectionIds: string[]): Promise<CitationRow[]> {
	if (collectionIds.length === 0) return [];
	return (
		await db.query<CitationRow>(
			`SELECT from_id, to_type, to_id, created_at
			 FROM citations
			 WHERE user_id = $1 AND from_type = 'collection' AND from_id = ANY($2::text[])
			 ORDER BY created_at DESC
			 LIMIT 120`,
			[userId, collectionIds],
		)
	).rows;
}

function collectPodcastTargets(directRows: CitationRow[], memberRows: CitationRow[]): CitationRow[] {
	const targets: CitationRow[] = [];
	const seen = new Set<string>();
	for (const row of directRows) addTarget(targets, seen, row);
	for (const row of memberRows) addTarget(targets, seen, row);
	return targets;
}

function targetIds(targets: CitationRow[], type: CitationRow['to_type']): string[] {
	return targets.filter((row) => row.to_type === type).map((row) => row.to_id);
}

async function loadTargetRows(
	db: DbClient,
	userId: string,
	targets: CitationRow[],
): Promise<{
	articles: ArticleRow[];
	collections: CollectionRow[];
	documents: DocumentRow[];
	files: UserFileRow[];
}> {
	const articleIds = targetIds(targets, 'article');
	const userFileIds = targetIds(targets, 'user_file');
	const documentIds = targetIds(targets, 'document');
	const collectionIds = targetIds(targets, 'collection');

	const [articles, files, documents, collections] = await Promise.all([
		articleIds.length
			? db.query<ArticleRow>(
					`SELECT id, title, title_cn, url, source, summary, summary_cn, content, content_cn
					 FROM articles WHERE id = ANY($1::uuid[])`,
					[articleIds],
				)
			: Promise.resolve({ rows: [] as ArticleRow[] }),
		userFileIds.length
			? db.query<UserFileRow>(
					`SELECT id, file_name, title, title_cn, source_url, site_name, summary, summary_cn, extracted_text, content_cn
					 FROM user_files WHERE id = ANY($1::uuid[]) AND user_id = $2`,
					[userFileIds, userId],
				)
			: Promise.resolve({ rows: [] as UserFileRow[] }),
		documentIds.length
			? db.query<DocumentRow>(
					`SELECT id, title, description, content, updated_at
					 FROM user_documents WHERE id = ANY($1::uuid[]) AND user_id = $2`,
					[documentIds, userId],
				)
			: Promise.resolve({ rows: [] as DocumentRow[] }),
		collectionIds.length
			? db.query<CollectionRow>(
					`SELECT id, name, description, article_count
					 FROM collections WHERE id = ANY($1::uuid[]) AND user_id = $2`,
					[collectionIds, userId],
				)
			: Promise.resolve({ rows: [] as CollectionRow[] }),
	]);

	return {
		articles: articles.rows,
		collections: collections.rows,
		documents: documents.rows,
		files: files.rows,
	};
}

function sourceMapFromRows(
	documents: DocumentRow[],
	targetRows: Awaited<ReturnType<typeof loadTargetRows>>,
): Map<string, PodcastContextSource> {
	const sourceByKey = new Map<string, PodcastContextSource>();
	for (const row of documents) sourceByKey.set(`document:${row.id}`, documentSource(row));
	for (const row of targetRows.documents) sourceByKey.set(`document:${row.id}`, documentSource(row));
	for (const row of targetRows.articles) sourceByKey.set(`article:${row.id}`, articleSource(row));
	for (const row of targetRows.files) sourceByKey.set(`user_file:${row.id}`, userFileSource(row));
	for (const row of targetRows.collections) sourceByKey.set(`collection:${row.id}`, collectionSource(row));
	return sourceByKey;
}

function orderedContextSources(
	documents: DocumentRow[],
	targets: CitationRow[],
	sourceByKey: Map<string, PodcastContextSource>,
): PodcastContextSource[] {
	const orderedKeys = [...documents.map((row) => `document:${row.id}`), ...targets.map((row) => `${row.to_type}:${row.to_id}`)];
	const sources: PodcastContextSource[] = [];
	const emitted = new Set<string>();
	for (const key of orderedKeys) {
		if (emitted.has(key)) continue;
		const source = sourceByKey.get(key);
		if (!source || !source.content.trim()) continue;
		emitted.add(key);
		sources.push(source);
		if (sources.length >= MAX_CONTEXT_SOURCES) break;
	}
	return sources;
}

export async function workspacePodcastContext(
	env: Env,
	input: { userId: string; workspaceId: string },
): Promise<WorkspacePodcastContextResult> {
	return withDbClient(env, async (db) => {
		const workspace = await assertWorkspace(db, input.userId, input.workspaceId);
		const [documents, directRows] = await Promise.all([
			db.query<DocumentRow>(
				`SELECT id, title, description, content, updated_at
				 FROM user_documents
				 WHERE workspace_id = $1 AND user_id = $2
				 ORDER BY updated_at DESC
				 LIMIT $3`,
				[input.workspaceId, input.userId, MAX_CONTEXT_DOCUMENTS],
			),
			db.query<CitationRow>(
				`SELECT to_type, to_id, created_at
				 FROM citations
				 WHERE user_id = $1 AND from_type = 'workspace' AND from_id = $2
				 ORDER BY created_at DESC
				 LIMIT 80`,
				[input.userId, input.workspaceId],
			),
		]);

		const collectionIds = directRows.rows.filter((row) => row.to_type === 'collection' && isUuid(row.to_id)).map((row) => row.to_id);
		const memberRows = await collectionMemberTargets(db, input.userId, collectionIds);
		const targets = collectPodcastTargets(directRows.rows, memberRows);
		const targetRows = await loadTargetRows(db, input.userId, targets);
		const sourceByKey = sourceMapFromRows(documents.rows, targetRows);
		const sources = orderedContextSources(documents.rows, targets, sourceByKey);

		return {
			workspaceId: workspace.id,
			title: workspace.title,
			description: workspace.description,
			sources,
			markdown: buildContextMarkdown(workspace, sources),
		};
	});
}

export async function updatePodcastScript(
	env: Env,
	input: { userId: string; podcastId: string; title: string; script: PodcastScript },
): Promise<PodcastSummary> {
	const parsed = parsePodcastScript(input.script);
	return withDbClient(env, async (db) => {
		const row = (
			await db.query<PodcastRow>(
				`UPDATE user_podcasts
				 SET title = $3, script = $4::jsonb, status = 'synthesizing', error = NULL, workflow_run_id = NULL, updated_at = NOW()
				 WHERE id = $1 AND user_id = $2
				 RETURNING id, workspace_id, title, status, audio_url, duration_sec, lang, error, created_at, updated_at`,
				[input.podcastId, input.userId, input.title.slice(0, 200), JSON.stringify(parsed)],
			)
		).rows[0];
		if (!row) throw new PodcastNotFoundError();
		return podcastSummary(row);
	});
}

export async function failPodcast(
	env: Env,
	input: { userId: string; podcastId: string; error: string; workflowRunId?: string },
): Promise<PodcastSummary> {
	return withDbClient(env, async (db) => {
		const workflowGuard = input.workflowRunId ? 'AND workflow_run_id = $4' : '';
		const values = input.workflowRunId
			? [input.podcastId, input.userId, input.error.slice(0, 1000), input.workflowRunId]
			: [input.podcastId, input.userId, input.error.slice(0, 1000)];
		const row = (
			await db.query<PodcastRow>(
				`UPDATE user_podcasts
				 SET status = 'failed', error = $3, updated_at = NOW()
				 WHERE id = $1 AND user_id = $2 AND status <> 'complete' ${workflowGuard}
				 RETURNING id, workspace_id, title, status, audio_url, duration_sec, lang, error, created_at, updated_at`,
				values,
			)
		).rows[0];
		if (!row) throw new PodcastNotFoundError();
		return podcastSummary(row);
	});
}

export async function preparePodcastRetry(
	env: Env,
	input: { userId: string; podcastId: string; workspaceId: string },
): Promise<{ needsScript: boolean; podcast: PodcastSummary }> {
	return withDbClient(env, async (db) => {
		const row = (
			await db.query<PodcastRow>(
				`UPDATE user_podcasts
				 SET status = CASE WHEN script IS NULL THEN 'scripting' ELSE 'synthesizing' END,
				     error = NULL,
				     audio_url = NULL,
				     duration_sec = NULL,
				     workflow_run_id = NULL,
				     updated_at = NOW()
				 WHERE id = $1
				   AND user_id = $2
				   AND workspace_id = $3
				   AND status = 'failed'
				 RETURNING id, workspace_id, title, status, audio_url, duration_sec, lang, error, created_at, updated_at, script`,
				[input.podcastId, input.userId, input.workspaceId],
			)
		).rows[0];
		if (!row) throw new PodcastNotReadyError();
		return { needsScript: row.script == null, podcast: podcastSummary(row) };
	});
}
