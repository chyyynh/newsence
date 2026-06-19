import { handleRSSCron } from '@ingest/platforms/rss/monitor';
import { handleTwitterCron } from '@ingest/platforms/twitter/monitor';
import { handleYouTubeCron } from '@ingest/platforms/youtube/monitor';
import { handleRetryCron } from '@ingest/retry';
import type { ProcessableTable, SourceArticleRef } from '@shared/db';
import { resolveProcessableTable } from '@shared/db';
import type { Env, ExecutionContext, MessageBatch, QueueMessage, ScheduledEvent, WorkflowQueueTarget } from '@shared/types';

export function handleScheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): void {
	console.info({ tag: 'CORE', msg: 'Scheduled', cron: event.cron });

	if (event.cron === '*/5 * * * *') ctx.waitUntil(handleRSSCron(env, ctx));
	else if (event.cron === '0 */6 * * *') ctx.waitUntil(handleTwitterCron(env, ctx));
	else if (event.cron === '*/30 * * * *') ctx.waitUntil(handleYouTubeCron(env, ctx));
	else if (event.cron === '0 3 * * *') ctx.waitUntil(handleRetryCron(env, ctx));
}

export async function handleArticleQueue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
	console.info({ tag: 'ARTICLE-QUEUE', msg: 'Received batch', count: batch.messages.length });

	for (const message of batch.messages) {
		const body = message.body;

		try {
			const targets = queueTargetsFromMessage(body);
			if (!targets.length) {
				console.warn({ tag: 'ARTICLE-QUEUE', msg: 'Unknown message type, acking' });
				message.ack();
				continue;
			}

			let created = 0;
			let existing = 0;
			for (const [index, target] of targets.entries()) {
				const result = await ensureTargetWorkflow(env, message.id, target, index);
				if (target.kind === 'source' && !result.sourceRefUsed) await cleanupUnusedSourceArticleDraft(env, target.source_article, result.id);
				if (result.created) created++;
				else existing++;
			}
			console.info({ tag: 'ARTICLE-QUEUE', msg: 'Ensured workflows', count: targets.length, created, existing });
			message.ack();
		} catch (err) {
			console.error({ tag: 'ARTICLE-QUEUE', msg: 'Error handling message, retrying', error: String(err) });
			message.retry();
		}
	}
}

function queueTargetsFromMessage(body: QueueMessage): WorkflowQueueTarget[] {
	switch (body.type) {
		case 'workflow_process':
			return [body.target];
		case 'batch_workflow_process':
			return body.targets;
		case 'source_article_process':
			return [{ kind: 'source', source_article: body.source_article }];
		case 'article_process':
			return [{ kind: 'row', article_id: body.article_id, ...(body.target_table ? { target_table: body.target_table } : {}) }];
		case 'batch_process':
			return body.article_ids.map((id) => ({
				kind: 'row',
				article_id: id,
				...(body.target_table ? { target_table: body.target_table } : {}),
			}));
	}
}

async function ensureTargetWorkflow(
	env: Env,
	messageId: string,
	target: WorkflowQueueTarget,
	index: number,
): Promise<{ id: string; created: boolean; sourceRefUsed?: boolean }> {
	if (target.kind === 'source') {
		const workflowId = await sourceArticleWorkflowId(target.source_article.url);
		return ensureSourceArticleWorkflow(env, workflowId, messageId, target.source_article);
	}

	const targetTable = resolveProcessableTable(target.target_table);
	const workflowId = articleWorkflowId(messageId, targetTable, target.article_id, index);
	return ensureArticleWorkflow(env, workflowId, target.article_id, targetTable);
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
	const existing = await env.MONITOR_WORKFLOW.get(workflowId);
	const existingStatus = await existing.status();
	if (isReusableSourceWorkflowStatus(existingStatus.status)) return { id: existing.id, created: false, sourceRefUsed: false };

	try {
		const instance = await env.MONITOR_WORKFLOW.create({
			id: workflowId,
			params: { source_article: sourceArticle },
		});
		return { id: instance.id, created: true, sourceRefUsed: true };
	} catch {
		const raced = await env.MONITOR_WORKFLOW.get(workflowId);
		const racedStatus = await raced.status();
		if (racedStatus.status !== 'unknown') return { id: raced.id, created: false, sourceRefUsed: false };
	}

	const retryWorkflowId = `${workflowId}-${workflowIdPart(messageId)}`;
	const existingRetry = await env.MONITOR_WORKFLOW.get(retryWorkflowId);
	const existingRetryStatus = await existingRetry.status();
	if (existingRetryStatus.status !== 'unknown') return { id: existingRetry.id, created: false, sourceRefUsed: true };

	try {
		const instance = await env.MONITOR_WORKFLOW.create({
			id: retryWorkflowId,
			params: { source_article: sourceArticle },
		});
		return { id: instance.id, created: true, sourceRefUsed: true };
	} catch (err) {
		const raced = await env.MONITOR_WORKFLOW.get(retryWorkflowId);
		const racedStatus = await raced.status();
		if (racedStatus.status !== 'unknown') return { id: raced.id, created: false, sourceRefUsed: true };
		throw err;
	}
}

function isReusableSourceWorkflowStatus(status: string): boolean {
	return status === 'complete' || ACTIVE_WORKFLOW_STATUSES.has(status);
}

async function cleanupUnusedSourceArticleDraft(env: Env, sourceArticle: SourceArticleRef, workflowId: string): Promise<void> {
	if (!('r2Key' in sourceArticle)) return;
	try {
		await env.R2.delete(sourceArticle.r2Key);
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
	const existing = await env.MONITOR_WORKFLOW.get(workflowId);
	const existingStatus = await existing.status();
	if (existingStatus.status !== 'unknown') return { id: existing.id, created: false };

	try {
		const instance = await env.MONITOR_WORKFLOW.create({
			id: workflowId,
			params: {
				article_id: articleId,
				target_table: targetTable,
			},
		});
		return { id: instance.id, created: true };
	} catch (err) {
		const raced = await env.MONITOR_WORKFLOW.get(workflowId);
		const racedStatus = await raced.status();
		if (racedStatus.status !== 'unknown') return { id: raced.id, created: false };
		throw err;
	}
}
