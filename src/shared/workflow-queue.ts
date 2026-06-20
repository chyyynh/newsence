import { ARTICLES_TABLE, type ProcessableTable, resolveProcessableTable, USER_FILES_TABLE } from './db';
import {
	cleanupSourceArticleDraftRef,
	createSourceArticleDraftRef,
	type SourceArticleDraft,
	type SourceArticleDraftRef,
	sourceArticleDraftUrl,
} from './source-draft';
import type { Env } from './types';
import { getUserFileWorkflowInstanceId, recordUserFileWorkflowInstanceId } from './user-file-workflow-state';

export type WorkflowQueueTarget =
	| { kind: 'row'; articleId: string; targetTable?: ProcessableTable }
	| { kind: 'source'; sourceArticle: SourceArticleDraftRef };

export type QueueMessage = { type: 'workflow_process'; target: WorkflowQueueTarget };
type QueueResult = { count: number; created: number; existing: number; skipped: number };

const ACTIVE_WORKFLOW_STATUSES = new Set(['queued', 'running', 'paused', 'waiting', 'waitingForPause']);

export async function enqueueArticleProcess(env: Env, articleId: string, targetTable?: ProcessableTable): Promise<void> {
	await env.ARTICLE_QUEUE.send({
		type: 'workflow_process',
		target: rowWorkflowTarget(articleId, targetTable),
	});
}

export async function enqueueArticleBatchProcess(env: Env, articleIds: string[], targetTable?: ProcessableTable): Promise<void> {
	if (!articleIds.length) return;
	await env.ARTICLE_QUEUE.sendBatch(
		articleIds.map((articleId) => ({
			body: {
				type: 'workflow_process',
				target: rowWorkflowTarget(articleId, targetTable),
			},
		})),
	);
}

function rowWorkflowTarget(articleId: string, targetTable?: ProcessableTable): WorkflowQueueTarget {
	return {
		kind: 'row',
		articleId,
		...(targetTable ? { targetTable } : {}),
	};
}

export async function enqueueSourceArticleProcess(env: Env, draft: SourceArticleDraft): Promise<void> {
	const sourceArticle = await createSourceArticleDraftRef(env, draft);

	try {
		await env.ARTICLE_QUEUE.send({
			type: 'workflow_process',
			target: { kind: 'source', sourceArticle },
		});
	} catch (err) {
		await cleanupQueuedSourceArticleDraft(env, sourceArticle, { reason: 'enqueue failed' });
		throw err;
	}
}

export async function ensureWorkflowsForQueueMessage(env: Env, messageId: string, body: unknown): Promise<QueueResult> {
	const message = parseQueueMessage(body);
	if (!message) {
		console.warn({ tag: 'ARTICLE-QUEUE', msg: 'Skipping invalid queue message', messageId });
		return { count: 0, created: 0, existing: 0, skipped: 1 };
	}

	const result = await ensureWorkflowForQueueTarget(env, messageId, message.target);
	return { count: 1, created: result.created ? 1 : 0, existing: result.created ? 0 : 1, skipped: 0 };
}

function parseQueueMessage(body: unknown): QueueMessage | null {
	if (!isRecord(body) || body.type !== 'workflow_process' || !isWorkflowQueueTarget(body.target)) return null;
	return body;
}

function isWorkflowQueueTarget(target: unknown): target is WorkflowQueueTarget {
	if (!isRecord(target)) return false;
	if (target.kind === 'row') {
		return (
			typeof target.articleId === 'string' &&
			target.articleId.length > 0 &&
			(target.targetTable === undefined || target.targetTable === ARTICLES_TABLE || target.targetTable === USER_FILES_TABLE)
		);
	}

	return target.kind === 'source' && isSourceArticleDraftRef(target.sourceArticle);
}

function isSourceArticleDraftRef(ref: unknown): ref is SourceArticleDraftRef {
	if (!isRecord(ref) || typeof ref.url !== 'string' || ref.url.length === 0) return false;
	return typeof ref.r2Key === 'string' && ref.r2Key.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function ensureWorkflowForQueueTarget(
	env: Env,
	messageId: string,
	target: WorkflowQueueTarget,
): Promise<{ id: string; created: boolean }> {
	if (target.kind === 'source') {
		const workflowId = await sourceArticleWorkflowId(sourceArticleDraftUrl(target.sourceArticle));
		const result = await ensureSourceArticleWorkflow(env, workflowId, messageId, target.sourceArticle);
		if (!result.sourceRefUsed) await cleanupUnusedSourceArticleDraft(env, target.sourceArticle, result.id);
		return { id: result.id, created: result.created };
	}

	const targetTable = resolveProcessableTable(target.targetTable);
	const workflowId = articleWorkflowId(messageId, targetTable, target.articleId);
	return ensureArticleWorkflow(env, workflowId, target.articleId, targetTable);
}

function articleWorkflowId(messageId: string, targetTable: ProcessableTable, articleId: string): string {
	return ['article', workflowIdPart(messageId), workflowIdPart(targetTable), workflowIdPart(articleId)].join('-');
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
	sourceArticle: SourceArticleDraftRef,
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

async function cleanupUnusedSourceArticleDraft(env: Env, sourceArticle: SourceArticleDraftRef, workflowId: string): Promise<void> {
	await cleanupQueuedSourceArticleDraft(env, sourceArticle, { reason: 'workflow already exists', workflowId });
}

async function cleanupQueuedSourceArticleDraft(
	env: Env,
	sourceArticle: SourceArticleDraftRef,
	context: { reason: string; workflowId?: string },
): Promise<void> {
	await cleanupSourceArticleDraftRef(env, sourceArticle, { ...context, logTag: 'ARTICLE-QUEUE' });
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
