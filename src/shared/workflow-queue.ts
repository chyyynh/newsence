import { createDbClient, type InsertArticleData, type ProcessableTable, USER_FILES_TABLE, type YoutubeTranscriptRow } from './db';
import type { TwitterMedia } from './platform-metadata';
import type { Article, Env, Tweet } from './types';
import { validateImageUrl } from './web';

type TwitterSourceEventType = 'tweet' | 'thread' | 'share' | 'quote' | 'retweet' | 'article';

export interface SourceArticleDraft {
	article: InsertArticleData;
	youtubeTranscript?: YoutubeTranscriptRow;
	twitterSourceEvent?: {
		tweet: Tweet;
		eventType: TwitterSourceEventType;
		text?: string | null;
		media?: TwitterMedia[];
		raw?: unknown;
	};
}

export type SourceArticleRef = { url: string; inline: SourceArticleDraft } | { url: string; r2Key: string };

export const SOURCE_ARTICLE_DRAFT_PREFIX = 'tmp/workflow/source-articles/';
const MAX_INLINE_SOURCE_ARTICLE_BYTES = 110_000;
const ACTIVE_WORKFLOW_STATUSES = new Set(['queued', 'running', 'paused', 'waiting', 'waitingForPause']);

export async function enqueueArticleProcess(env: Env, articleId: string, targetTable?: ProcessableTable): Promise<void> {
	await env.ARTICLE_QUEUE.send({
		type: 'workflow_process',
		target: {
			kind: 'row',
			article_id: articleId,
			...(targetTable ? { target_table: targetTable } : {}),
		},
	});
}

export async function enqueueSourceArticleProcess(env: Env, draft: SourceArticleDraft): Promise<void> {
	const article = {
		...draft.article,
		ogImageUrl: await validateImageUrl(draft.article.ogImageUrl),
	};
	const normalizedDraft: SourceArticleDraft = { ...draft, article };
	const serialized = JSON.stringify(normalizedDraft);
	const url = article.url;
	const source_article: SourceArticleRef =
		new TextEncoder().encode(serialized).byteLength <= MAX_INLINE_SOURCE_ARTICLE_BYTES
			? { url, inline: normalizedDraft }
			: await writeSourceArticleDraft(env, url, serialized);

	await env.ARTICLE_QUEUE.send({
		type: 'workflow_process',
		target: { kind: 'source', source_article },
	});
}

async function writeSourceArticleDraft(env: Env, url: string, serialized: string): Promise<SourceArticleRef> {
	const r2Key = `${SOURCE_ARTICLE_DRAFT_PREFIX}${crypto.randomUUID()}.json`;
	await env.R2.put(r2Key, serialized, {
		httpMetadata: { contentType: 'application/json; charset=utf-8' },
	});
	return { url, r2Key };
}

export async function readSourceArticleDraft(env: Env, ref: SourceArticleRef): Promise<SourceArticleDraft> {
	if ('inline' in ref) return ref.inline;
	if (!ref.r2Key.startsWith(SOURCE_ARTICLE_DRAFT_PREFIX)) throw new Error(`Invalid source article draft key: ${ref.r2Key}`);
	const obj = await env.R2.get(ref.r2Key);
	if (!obj) throw new Error(`Source article draft missing: ${ref.r2Key}`);
	return JSON.parse(await obj.text()) as SourceArticleDraft;
}

export function articleFromSourceDraft(draft: SourceArticleDraft): Article {
	const data = draft.article;
	return {
		id: data.url,
		title: data.title,
		title_cn: null,
		summary: data.summary || null,
		summary_cn: null,
		content: data.content,
		content_cn: null,
		url: data.url,
		source: data.source,
		published_date: typeof data.publishedDate === 'string' ? data.publishedDate : data.publishedDate.toISOString(),
		tags: data.tags ?? [],
		keywords: data.keywords ?? [],
		source_type: data.sourceType,
		og_image_url: data.ogImageUrl,
		platform_metadata: data.platformMetadata as Article['platform_metadata'],
	};
}

export async function createUserFileWorkflow(env: Env, userFileId: string): Promise<string | undefined> {
	try {
		const storedInstanceId = await getUserFileWorkflowInstanceId(env, userFileId);
		if (storedInstanceId) {
			const storedInstance = await env.MONITOR_WORKFLOW.get(storedInstanceId);
			const storedStatus = await storedInstance.status();
			if (ACTIVE_WORKFLOW_STATUSES.has(storedStatus.status)) return storedInstance.id;
		}

		const baseId = userFileWorkflowId(userFileId);
		const workflowId = storedInstanceId ? `${baseId}-${crypto.randomUUID()}` : baseId;
		const instanceId = await createUserFileWorkflowInstance(env, workflowId, userFileId);
		await recordUserFileWorkflowInstanceId(env, userFileId, instanceId);
		return instanceId;
	} catch (err) {
		console.error({ tag: 'WORKFLOW', msg: 'create failed', userFileId, error: String(err) });
		return undefined;
	}
}

function userFileWorkflowId(userFileId: string): string {
	return `user-file-${userFileId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80)}`;
}

async function createUserFileWorkflowInstance(env: Env, workflowId: string, userFileId: string): Promise<string> {
	try {
		const instance = await env.MONITOR_WORKFLOW.create({
			id: workflowId,
			params: { article_id: userFileId, target_table: USER_FILES_TABLE },
		});
		return instance.id;
	} catch (err) {
		const existing = await env.MONITOR_WORKFLOW.get(workflowId);
		const existingStatus = await existing.status();
		if (ACTIVE_WORKFLOW_STATUSES.has(existingStatus.status)) return existing.id;
		if (existingStatus.status === 'unknown') throw err;

		const instance = await env.MONITOR_WORKFLOW.create({
			id: `${workflowId}-${crypto.randomUUID()}`,
			params: { article_id: userFileId, target_table: USER_FILES_TABLE },
		});
		return instance.id;
	}
}

async function getUserFileWorkflowInstanceId(env: Env, userFileId: string): Promise<string | null> {
	const db = await createDbClient(env);
	try {
		const result = await db.query(
			`SELECT metadata->'workflow'->>'monitor_instance_id' AS instance_id FROM ${USER_FILES_TABLE} WHERE id = $1`,
			[userFileId],
		);
		const row = result.rows[0] as { instance_id?: string | null } | undefined;
		return row?.instance_id ?? null;
	} finally {
		await db.end();
	}
}

async function recordUserFileWorkflowInstanceId(env: Env, userFileId: string, instanceId: string): Promise<void> {
	const db = await createDbClient(env);
	try {
		const metadata = JSON.stringify({
			workflow: {
				monitor_instance_id: instanceId,
				monitor_started_at: new Date().toISOString(),
			},
		});
		await db.query(`UPDATE ${USER_FILES_TABLE} SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE id = $2`, [
			metadata,
			userFileId,
		]);
	} finally {
		await db.end();
	}
}
