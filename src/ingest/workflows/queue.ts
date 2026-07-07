import {
	ARTICLES_TABLE,
	getIncompleteWorkflowTargetIds,
	type InsertArticleData,
	type ProcessableTable,
	USER_FILES_TABLE,
} from '@core-shared/article-store';
import type { TwitterMedia } from '@core-shared/platform-metadata';
import type { Tweet } from '@core-shared/types';
import type { YoutubeTranscriptRow } from '@ingest/platforms/youtube/transcripts';
import { Client } from 'pg';

export type WorkflowQueueTarget =
	| { kind: 'row'; articleId: string; targetTable?: ProcessableTable }
	| { kind: 'source'; sourceArticle: SourceArticleDraftRef };

type TwitterSourceEventType = 'tweet' | 'thread' | 'share' | 'quote' | 'retweet' | 'article';
export type TwitterSourceEventDraft = {
	tweet: Tweet;
	eventType: TwitterSourceEventType;
	text?: string | null;
	media?: TwitterMedia[];
	raw?: unknown;
};
type SourceArticleAttachment =
	| { kind: 'youtube-transcript'; transcript: YoutubeTranscriptRow }
	| { kind: 'twitter-source-event'; event: TwitterSourceEventDraft };
export interface SourceArticleDraft {
	article: InsertArticleData;
	attachments?: SourceArticleAttachment[];
}
export type SourceArticleDraftRef = { url: string; r2Key: string };
type RowWorkflowTarget = Extract<WorkflowQueueTarget, { kind: 'row' }>;
export type QueueMessage = RowWorkflowTarget;
export type QueueResult = { count: number; created: number; existing: number };
type UserFileWorkflowMetadataPatch = Record<string, string>;

const ACTIVE_WORKFLOW_STATUSES = new Set(['queued', 'running', 'paused', 'waiting', 'waitingForPause']);
const RETRY_BATCH_SIZE = 20;
const SOURCE_ARTICLE_DRAFT_PREFIX = 'tmp/workflow/source-articles/';
const SOURCE_ARTICLE_DRAFT_CONTENT_TYPE = 'application/json; charset=utf-8';

export async function enqueueArticleBatchProcess(env: Env, articleIds: string[], targetTable?: ProcessableTable): Promise<void> {
	if (!articleIds.length) return;
	await env.ARTICLE_QUEUE.sendBatch(
		articleIds.map((articleId) => ({
			body: { kind: 'row', articleId, ...(targetTable ? { targetTable } : {}) },
		})),
	);
}

export async function handleRetryCron(env: Env): Promise<void> {
	console.info({ tag: 'RETRY', msg: 'start' });
	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
	const { articleIds, userFileIds } = await getIncompleteWorkflowTargetIds(db, since);
	const total = articleIds.length + userFileIds.length;

	if (!total) return console.info({ tag: 'RETRY', msg: 'No incomplete articles' });
	for (let i = 0; i < articleIds.length; i += RETRY_BATCH_SIZE) {
		await enqueueArticleBatchProcess(env, articleIds.slice(i, i + RETRY_BATCH_SIZE));
	}
	for (let i = 0; i < userFileIds.length; i += RETRY_BATCH_SIZE) {
		await enqueueArticleBatchProcess(env, userFileIds.slice(i, i + RETRY_BATCH_SIZE), USER_FILES_TABLE);
	}
	console.info({
		tag: 'RETRY',
		msg: 'Queued articles for retry',
		articles: articleIds.length,
		userFiles: userFileIds.length,
		batches: Math.ceil(articleIds.length / RETRY_BATCH_SIZE) + Math.ceil(userFileIds.length / RETRY_BATCH_SIZE),
	});
}

export async function startSourceArticleWorkflow(env: Env, draft: SourceArticleDraft): Promise<void> {
	const sourceArticle = { url: draft.article.url, r2Key: `${SOURCE_ARTICLE_DRAFT_PREFIX}${crypto.randomUUID()}.json` };
	await env.R2.put(sourceArticle.r2Key, JSON.stringify(draft), { httpMetadata: { contentType: SOURCE_ARTICLE_DRAFT_CONTENT_TYPE } });

	try {
		const workflowId = await sourceArticleWorkflowId(sourceArticle.url);
		const result = await ensureSourceArticleWorkflow(env, workflowId, sourceArticle);
		if (!result.sourceRefUsed)
			await cleanupSourceArticleDraftRef(env, sourceArticle, {
				reason: 'workflow already exists',
				workflowId: result.id,
				logTag: 'SOURCE-WORKFLOW',
			});
	} catch (err) {
		await cleanupSourceArticleDraftRef(env, sourceArticle, { reason: 'workflow create failed', logTag: 'SOURCE-WORKFLOW' });
		throw err;
	}
}

export async function readSourceArticleDraft(env: Env, ref: SourceArticleDraftRef): Promise<SourceArticleDraft> {
	if (!ref.r2Key.startsWith(SOURCE_ARTICLE_DRAFT_PREFIX)) throw new Error(`Invalid source article draft key: ${ref.r2Key}`);
	const obj = await env.R2.get(ref.r2Key);
	if (!obj) throw new Error(`source article draft missing: ${ref.r2Key}`);
	return obj.json<SourceArticleDraft>();
}

export async function createWorkflowsForQueueMessages(env: Env, messages: readonly Message<QueueMessage>[]): Promise<QueueResult> {
	if (!messages.length) return { count: 0, created: 0, existing: 0 };

	const instances = await env.MONITOR_WORKFLOW.createBatch(
		messages.map(({ id, body: target }) => {
			const targetTable = target.targetTable ?? ARTICLES_TABLE;
			return {
				id: ['article', workflowIdPart(id), workflowIdPart(targetTable), workflowIdPart(target.articleId)].join('-'),
				params: { target: { kind: 'row', articleId: target.articleId, targetTable } },
			};
		}),
	);

	return { count: messages.length, created: instances.length, existing: messages.length - instances.length };
}

function workflowIdPart(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
}

async function sourceArticleWorkflowId(url: string): Promise<string> {
	const bytes = new TextEncoder().encode(url);
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	const hash = [...new Uint8Array(digest)]
		.slice(0, 16)
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
	return `source-article-${hash}`;
}

async function ensureSourceArticleWorkflow(
	env: Env,
	workflowId: string,
	sourceArticle: SourceArticleDraftRef,
): Promise<{ id: string; created: boolean; sourceRefUsed: boolean }> {
	const existing = await getMonitorWorkflowStatus(env, workflowId);
	if (isReusableSourceWorkflowStatus(existing.status)) return { id: existing.id, created: false, sourceRefUsed: false };

	if (existing.status === 'unknown') {
		try {
			const instance = await env.MONITOR_WORKFLOW.create({ id: workflowId, params: { target: { kind: 'source', sourceArticle } } });
			const id = instance.id;
			return { id, created: true, sourceRefUsed: true };
		} catch {
			const raced = await getMonitorWorkflowStatus(env, workflowId);
			if (isReusableSourceWorkflowStatus(raced.status)) return { id: raced.id, created: false, sourceRefUsed: false };
			if (raced.status === 'unknown') throw new Error(`Failed to create source workflow ${workflowId}`);
		}
	}

	const retryWorkflowId = `${workflowId}-${crypto.randomUUID()}`;
	try {
		const instance = await env.MONITOR_WORKFLOW.create({ id: retryWorkflowId, params: { target: { kind: 'source', sourceArticle } } });
		const id = instance.id;
		return { id, created: true, sourceRefUsed: true };
	} catch (err) {
		const raced = await getMonitorWorkflowStatus(env, retryWorkflowId);
		if (raced.status !== 'unknown') return { id: raced.id, created: false, sourceRefUsed: true };
		throw err;
	}
}

function isReusableSourceWorkflowStatus(status: string): boolean {
	return status === 'complete' || ACTIVE_WORKFLOW_STATUSES.has(status);
}

export async function cleanupSourceArticleDraftRef(
	env: Env,
	ref: SourceArticleDraftRef,
	context: { reason: string; workflowId?: string; logTag?: string },
): Promise<void> {
	try {
		if (!ref.r2Key.startsWith(SOURCE_ARTICLE_DRAFT_PREFIX)) throw new Error(`Invalid source article draft key: ${ref.r2Key}`);
		await env.R2.delete(ref.r2Key);
	} catch (err) {
		console.warn({
			tag: context.logTag ?? 'SOURCE-DRAFT',
			msg: 'Failed to cleanup source article draft',
			reason: context.reason,
			workflowId: context.workflowId,
			sourceUrl: ref.url,
			error: String(err),
		});
	}
}

export async function createUserFileWorkflow(env: Env, userFileId: string, db?: Client): Promise<string | undefined> {
	try {
		const client = db ?? new Client({ connectionString: env.HYPERDRIVE.connectionString });
		if (!db) await client.connect();
		const result = await client.query(
			`SELECT metadata->'workflow'->>'monitor_instance_id' AS instance_id FROM ${USER_FILES_TABLE} WHERE id = $1`,
			[userFileId],
		);
		const row = result.rows[0] as { instance_id?: string | null } | undefined;
		const storedInstanceId = row?.instance_id ?? null;
		if (storedInstanceId) {
			const stored = await getMonitorWorkflowStatus(env, storedInstanceId);
			if (ACTIVE_WORKFLOW_STATUSES.has(stored.status)) return stored.id;
		}

		const baseId = `user-file-${workflowIdPart(userFileId)}`;
		const workflowId = storedInstanceId ? `${baseId}-${crypto.randomUUID()}` : baseId;
		let instanceId: string;
		try {
			const instance = await env.MONITOR_WORKFLOW.create({
				id: workflowId,
				params: { target: { kind: 'row', articleId: userFileId, targetTable: USER_FILES_TABLE } },
			});
			instanceId = instance.id;
		} catch (err) {
			const existing = await getMonitorWorkflowStatus(env, workflowId);
			if (ACTIVE_WORKFLOW_STATUSES.has(existing.status)) {
				instanceId = existing.id;
			} else {
				if (existing.status === 'unknown') throw err;
				const instance = await env.MONITOR_WORKFLOW.create({
					id: `${workflowId}-${crypto.randomUUID()}`,
					params: { target: { kind: 'row', articleId: userFileId, targetTable: USER_FILES_TABLE } },
				});
				instanceId = instance.id;
			}
		}
		await patchUserFileWorkflowMetadata(client, userFileId, {
			monitor_instance_id: instanceId,
			monitor_status: 'running',
			monitor_started_at: new Date().toISOString(),
		});
		return instanceId;
	} catch (err) {
		console.error({ tag: 'WORKFLOW', msg: 'create failed', userFileId, error: String(err) });
		return undefined;
	}
}

export async function recordUserFileWorkflowComplete(db: Client, userFileId: string, articleId: string): Promise<void> {
	await patchUserFileWorkflowMetadata(db, userFileId, {
		monitor_status: 'complete',
		monitor_completed_at: new Date().toISOString(),
		article_id: articleId,
	});
}

export async function recordUserFileWorkflowFailed(env: Env, userFileId: string, error: string): Promise<void> {
	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	await patchUserFileWorkflowMetadata(db, userFileId, {
		monitor_status: 'failed',
		monitor_failed_at: new Date().toISOString(),
		error: error.slice(0, 500),
	});
}

async function patchUserFileWorkflowMetadata(db: Client, userFileId: string, patch: UserFileWorkflowMetadataPatch): Promise<void> {
	await db.query(
		`UPDATE ${USER_FILES_TABLE}
		 SET metadata = jsonb_set(
		   COALESCE(metadata, '{}'::jsonb),
		   '{workflow}',
		   COALESCE(metadata->'workflow', '{}'::jsonb) || $1::jsonb,
		   TRUE
		 )
		 WHERE id = $2`,
		[JSON.stringify(patch), userFileId],
	);
}

async function getMonitorWorkflowStatus(env: Env, workflowId: string): Promise<{ id: string; status: string }> {
	try {
		const instance = await env.MONITOR_WORKFLOW.get(workflowId);
		const status = await instance.status();
		return { id: instance.id, status: status.status };
	} catch {
		// `MONITOR_WORKFLOW.get()` throws when the instance ID was never created (or
		// has aged out of retention). Every caller treats `'unknown'` as "not a live
		// workflow", so normalize the not-found throw to that — otherwise the very
		// first status check for a brand-new article aborts the ensure/create path
		// and the queue message retries forever. A real existing instance is still
		// surfaced via the create-conflict retry, so a transient get error is not lost.
		return { id: workflowId, status: 'unknown' };
	}
}
