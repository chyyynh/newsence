import {
	type InsertArticleData,
	type ProcessableTable,
	resolveProcessableTable,
	USER_FILES_TABLE,
	withDbClient,
	type YoutubeTranscriptRow,
} from './db';
import type { TwitterMedia } from './platform-metadata';
import { deleteTempObject, putTempText, readTempText } from './r2-temp';
import type { Env, Tweet } from './types';
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

export type WorkflowQueueTarget =
	| { kind: 'row'; articleId: string; targetTable?: ProcessableTable }
	| { kind: 'source'; sourceArticle: SourceArticleRef };

export type QueueMessage =
	| { type: 'workflow_process'; target: WorkflowQueueTarget }
	| { type: 'batch_workflow_process'; targets: WorkflowQueueTarget[] };

export const SOURCE_ARTICLE_DRAFT_PREFIX = 'tmp/workflow/source-articles/';
const MAX_INLINE_SOURCE_ARTICLE_BYTES = 110_000;
const ACTIVE_WORKFLOW_STATUSES = new Set(['queued', 'running', 'paused', 'waiting', 'waitingForPause']);

export async function enqueueArticleProcess(env: Env, articleId: string, targetTable?: ProcessableTable): Promise<void> {
	await env.ARTICLE_QUEUE.send({
		type: 'workflow_process',
		target: rowWorkflowTarget(articleId, targetTable),
	});
}

export async function enqueueArticleBatchProcess(env: Env, articleIds: string[], targetTable?: ProcessableTable): Promise<void> {
	if (!articleIds.length) return;
	await env.ARTICLE_QUEUE.send({
		type: 'batch_workflow_process',
		targets: articleIds.map((articleId) => rowWorkflowTarget(articleId, targetTable)),
	});
}

function rowWorkflowTarget(articleId: string, targetTable?: ProcessableTable): WorkflowQueueTarget {
	return {
		kind: 'row',
		articleId,
		...(targetTable ? { targetTable } : {}),
	};
}

export async function enqueueSourceArticleProcess(env: Env, draft: SourceArticleDraft): Promise<void> {
	const article = {
		...draft.article,
		ogImageUrl: await validateImageUrl(draft.article.ogImageUrl),
	};
	const normalizedDraft: SourceArticleDraft = { ...draft, article };
	const serialized = JSON.stringify(normalizedDraft);
	const url = article.url;
	const sourceArticle: SourceArticleRef =
		new TextEncoder().encode(serialized).byteLength <= MAX_INLINE_SOURCE_ARTICLE_BYTES
			? { url, inline: normalizedDraft }
			: await writeSourceArticleDraft(env, url, serialized);

	await env.ARTICLE_QUEUE.send({
		type: 'workflow_process',
		target: { kind: 'source', sourceArticle },
	});
}

async function writeSourceArticleDraft(env: Env, url: string, serialized: string): Promise<SourceArticleRef> {
	const r2Key = `${SOURCE_ARTICLE_DRAFT_PREFIX}${crypto.randomUUID()}.json`;
	await putTempText(env, r2Key, serialized, 'application/json; charset=utf-8');
	return { url, r2Key };
}

export async function readSourceArticleDraft(env: Env, ref: SourceArticleRef): Promise<SourceArticleDraft> {
	if ('inline' in ref) return ref.inline;
	const text = await readTempText(env, ref.r2Key, { prefix: SOURCE_ARTICLE_DRAFT_PREFIX, label: 'source article draft' });
	return JSON.parse(text) as SourceArticleDraft;
}

export async function deleteSourceArticleDraft(env: Env, ref: SourceArticleRef): Promise<void> {
	if (!('r2Key' in ref)) return;
	await deleteTempObject(env, ref.r2Key, { prefix: SOURCE_ARTICLE_DRAFT_PREFIX, label: 'source article draft' });
}

export async function ensureWorkflowsForQueueMessage(
	env: Env,
	messageId: string,
	body: QueueMessage,
): Promise<{ count: number; created: number; existing: number }> {
	const targets = queueTargetsFromMessage(body);
	let created = 0;
	let existing = 0;

	for (const [index, target] of targets.entries()) {
		const result = await ensureWorkflowForQueueTarget(env, messageId, target, index);
		if (result.created) created++;
		else existing++;
	}

	return { count: targets.length, created, existing };
}

function queueTargetsFromMessage(body: QueueMessage): WorkflowQueueTarget[] {
	return body.type === 'workflow_process' ? [body.target] : body.targets;
}

async function ensureWorkflowForQueueTarget(
	env: Env,
	messageId: string,
	target: WorkflowQueueTarget,
	index: number,
): Promise<{ id: string; created: boolean }> {
	if (target.kind === 'source') {
		const workflowId = await sourceArticleWorkflowId(target.sourceArticle.url);
		const result = await ensureSourceArticleWorkflow(env, workflowId, messageId, target.sourceArticle);
		if (!result.sourceRefUsed) await cleanupUnusedSourceArticleDraft(env, target.sourceArticle, result.id);
		return { id: result.id, created: result.created };
	}

	const targetTable = resolveProcessableTable(target.targetTable);
	const workflowId = articleWorkflowId(messageId, targetTable, target.articleId, index);
	return ensureArticleWorkflow(env, workflowId, target.articleId, targetTable);
}

function articleWorkflowId(messageId: string, targetTable: ProcessableTable, articleId: string, index: number): string {
	return ['article', workflowIdPart(messageId), workflowIdPart(targetTable), String(index), workflowIdPart(articleId)].join('-');
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
	messageId: string,
	sourceArticle: SourceArticleRef,
): Promise<{ id: string; created: boolean; sourceRefUsed: boolean }> {
	const existing = await getMonitorWorkflowStatus(env, workflowId);
	if (isReusableSourceWorkflowStatus(existing.status)) return { id: existing.id, created: false, sourceRefUsed: false };

	try {
		const id = await createMonitorWorkflow(env, workflowId, { kind: 'source', sourceArticle });
		return { id, created: true, sourceRefUsed: true };
	} catch {
		const raced = await getMonitorWorkflowStatus(env, workflowId);
		if (raced.status !== 'unknown') return { id: raced.id, created: false, sourceRefUsed: false };
	}

	const retryWorkflowId = `${workflowId}-${workflowIdPart(messageId)}`;
	const existingRetry = await getMonitorWorkflowStatus(env, retryWorkflowId);
	if (existingRetry.status !== 'unknown') return { id: existingRetry.id, created: false, sourceRefUsed: true };

	try {
		const id = await createMonitorWorkflow(env, retryWorkflowId, { kind: 'source', sourceArticle });
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

async function cleanupUnusedSourceArticleDraft(env: Env, sourceArticle: SourceArticleRef, workflowId: string): Promise<void> {
	if (!('r2Key' in sourceArticle)) return;
	try {
		await deleteSourceArticleDraft(env, sourceArticle);
	} catch (err) {
		console.warn({
			tag: 'ARTICLE-QUEUE',
			msg: 'Failed to cleanup unused source article draft',
			workflowId,
			r2Key: sourceArticle.r2Key,
			error: String(err),
		});
	}
}

async function ensureArticleWorkflow(
	env: Env,
	workflowId: string,
	articleId: string,
	targetTable: ProcessableTable,
): Promise<{ id: string; created: boolean }> {
	const existing = await getMonitorWorkflowStatus(env, workflowId);
	if (existing.status !== 'unknown') return { id: existing.id, created: false };

	try {
		const id = await createMonitorWorkflow(env, workflowId, rowWorkflowTarget(articleId, targetTable));
		return { id, created: true };
	} catch (err) {
		const raced = await getMonitorWorkflowStatus(env, workflowId);
		if (raced.status !== 'unknown') return { id: raced.id, created: false };
		throw err;
	}
}

export async function createUserFileWorkflow(env: Env, userFileId: string): Promise<string | undefined> {
	try {
		const storedInstanceId = await getUserFileWorkflowInstanceId(env, userFileId);
		if (storedInstanceId) {
			const stored = await getMonitorWorkflowStatus(env, storedInstanceId);
			if (ACTIVE_WORKFLOW_STATUSES.has(stored.status)) return stored.id;
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
		return createMonitorWorkflow(env, workflowId, rowWorkflowTarget(userFileId, USER_FILES_TABLE));
	} catch (err) {
		const existing = await getMonitorWorkflowStatus(env, workflowId);
		if (ACTIVE_WORKFLOW_STATUSES.has(existing.status)) return existing.id;
		if (existing.status === 'unknown') throw err;

		return createMonitorWorkflow(env, `${workflowId}-${crypto.randomUUID()}`, rowWorkflowTarget(userFileId, USER_FILES_TABLE));
	}
}

async function getMonitorWorkflowStatus(env: Env, workflowId: string): Promise<{ id: string; status: string }> {
	const instance = await env.MONITOR_WORKFLOW.get(workflowId);
	const status = await instance.status();
	return { id: instance.id, status: status.status };
}

async function createMonitorWorkflow(env: Env, workflowId: string, target: WorkflowQueueTarget): Promise<string> {
	const instance = await env.MONITOR_WORKFLOW.create({
		id: workflowId,
		params: { target },
	});
	return instance.id;
}

async function getUserFileWorkflowInstanceId(env: Env, userFileId: string): Promise<string | null> {
	return withDbClient(env, async (db) => {
		const result = await db.query(
			`SELECT metadata->'workflow'->>'monitor_instance_id' AS instance_id FROM ${USER_FILES_TABLE} WHERE id = $1`,
			[userFileId],
		);
		const row = result.rows[0] as { instance_id?: string | null } | undefined;
		return row?.instance_id ?? null;
	});
}

async function recordUserFileWorkflowInstanceId(env: Env, userFileId: string, instanceId: string): Promise<void> {
	return withDbClient(env, async (db) => {
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
	});
}
