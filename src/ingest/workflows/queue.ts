import {
	getIncompleteWorkflowTargetIds,
	type ProcessableTable,
	resolveProcessableTable,
	USER_FILES_TABLE,
} from '@core-shared/article-store';
import { type DbClient, withDbClient } from '@core-shared/db';
import type { Env } from '@core-shared/types';
import {
	cleanupSourceArticleDraftRef,
	createSourceArticleDraftRef,
	type SourceArticleDraft,
	type SourceArticleDraftRef,
} from '@ingest/workflows/source-draft';

export type WorkflowQueueTarget =
	| { kind: 'row'; articleId: string; targetTable?: ProcessableTable }
	| { kind: 'source'; sourceArticle: SourceArticleDraftRef };

type RowWorkflowTarget = Extract<WorkflowQueueTarget, { kind: 'row' }>;
export type QueueMessage = RowWorkflowTarget;
export type QueueResult = { count: number; created: number; existing: number };
type UserFileWorkflowMetadataPatch = Record<string, string>;

const ACTIVE_WORKFLOW_STATUSES = new Set(['queued', 'running', 'paused', 'waiting', 'waitingForPause']);
const RETRY_BATCH_SIZE = 20;

export async function enqueueArticleProcess(env: Env, articleId: string, targetTable?: ProcessableTable): Promise<void> {
	await env.ARTICLE_QUEUE.send(rowWorkflowTarget(articleId, targetTable));
}

export async function enqueueArticleBatchProcess(env: Env, articleIds: string[], targetTable?: ProcessableTable): Promise<void> {
	if (!articleIds.length) return;
	await env.ARTICLE_QUEUE.sendBatch(
		articleIds.map((articleId) => ({
			body: rowWorkflowTarget(articleId, targetTable),
		})),
	);
}

function rowWorkflowTarget(articleId: string, targetTable?: ProcessableTable): RowWorkflowTarget {
	return {
		kind: 'row',
		articleId,
		...(targetTable ? { targetTable } : {}),
	};
}

export async function handleRetryCron(env: Env, _ctx: ExecutionContext): Promise<void> {
	console.info({ tag: 'RETRY', msg: 'start' });
	await withDbClient(env, async (db) => {
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
	});
}

export async function startSourceArticleWorkflow(env: Env, draft: SourceArticleDraft): Promise<void> {
	const sourceArticle = await createSourceArticleDraftRef(env, draft);

	try {
		const workflowId = await sourceArticleWorkflowId(sourceArticle.url);
		const result = await ensureSourceArticleWorkflow(env, workflowId, sourceArticle);
		if (!result.sourceRefUsed) await cleanupUnusedSourceArticleDraft(env, sourceArticle, result.id);
	} catch (err) {
		await cleanupSourceWorkflowDraft(env, sourceArticle, { reason: 'workflow create failed' });
		throw err;
	}
}

export async function createWorkflowsForQueueMessages(env: Env, messages: readonly Message<QueueMessage>[]): Promise<QueueResult> {
	if (!messages.length) return { count: 0, created: 0, existing: 0 };

	const instances = await env.MONITOR_WORKFLOW.createBatch(
		messages.map(({ id, body: target }) => {
			const targetTable = resolveProcessableTable(target.targetTable);
			return {
				id: articleWorkflowId(id, targetTable, target.articleId),
				params: { target: rowWorkflowTarget(target.articleId, targetTable) },
			};
		}),
	);

	return { count: messages.length, created: instances.length, existing: messages.length - instances.length };
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
	sourceArticle: SourceArticleDraftRef,
): Promise<{ id: string; created: boolean; sourceRefUsed: boolean }> {
	const existing = await getMonitorWorkflowStatus(env, workflowId);
	if (isReusableSourceWorkflowStatus(existing.status)) return { id: existing.id, created: false, sourceRefUsed: false };

	if (existing.status === 'unknown') {
		try {
			const id = await createMonitorWorkflow(env, workflowId, { kind: 'source', sourceArticle });
			return { id, created: true, sourceRefUsed: true };
		} catch {
			const raced = await getMonitorWorkflowStatus(env, workflowId);
			if (isReusableSourceWorkflowStatus(raced.status)) return { id: raced.id, created: false, sourceRefUsed: false };
			if (raced.status === 'unknown') throw new Error(`Failed to create source workflow ${workflowId}`);
		}
	}

	const retryWorkflowId = `${workflowId}-${crypto.randomUUID()}`;
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
	await cleanupSourceWorkflowDraft(env, sourceArticle, { reason: 'workflow already exists', workflowId });
}

async function cleanupSourceWorkflowDraft(
	env: Env,
	sourceArticle: SourceArticleDraftRef,
	context: { reason: string; workflowId?: string },
): Promise<void> {
	await cleanupSourceArticleDraftRef(env, sourceArticle, { ...context, logTag: 'SOURCE-WORKFLOW' });
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

export async function recordUserFileWorkflowComplete(db: DbClient, userFileId: string, articleId: string): Promise<void> {
	await patchUserFileWorkflowMetadata(db, userFileId, {
		monitor_status: 'complete',
		monitor_completed_at: new Date().toISOString(),
		article_id: articleId,
	});
}

export async function recordUserFileWorkflowFailed(env: Env, userFileId: string, error: string): Promise<void> {
	await withDbClient(env, (db) =>
		patchUserFileWorkflowMetadata(db, userFileId, {
			monitor_status: 'failed',
			monitor_failed_at: new Date().toISOString(),
			error: error.slice(0, 500),
		}),
	);
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
	await withDbClient(env, (db) =>
		patchUserFileWorkflowMetadata(db, userFileId, {
			monitor_instance_id: instanceId,
			monitor_status: 'running',
			monitor_started_at: new Date().toISOString(),
		}),
	);
}

async function patchUserFileWorkflowMetadata(db: DbClient, userFileId: string, patch: UserFileWorkflowMetadataPatch): Promise<void> {
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

async function createMonitorWorkflow(env: Env, workflowId: string, target: WorkflowQueueTarget): Promise<string> {
	const instance = await env.MONITOR_WORKFLOW.create({
		id: workflowId,
		params: { target },
	});
	return instance.id;
}
