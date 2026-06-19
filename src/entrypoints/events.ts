import { handleRSSCron } from '@ingest/platforms/rss/monitor';
import { handleTwitterCron } from '@ingest/platforms/twitter/monitor';
import { handleYouTubeCron } from '@ingest/platforms/youtube/monitor';
import { handleRetryCron } from '@ingest/retry';
import type { ProcessableTable } from '@shared/db';
import { resolveProcessableTable } from '@shared/db';
import type { Env, ExecutionContext, MessageBatch, QueueMessage, ScheduledEvent } from '@shared/types';

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
			if (body.type !== 'article_process' && body.type !== 'batch_process') {
				console.warn({ tag: 'ARTICLE-QUEUE', msg: 'Unknown message type, acking' });
				message.ack();
				continue;
			}

			const targetTable = resolveProcessableTable(body.target_table);
			const ids = body.type === 'article_process' ? [body.article_id] : body.article_ids;
			let created = 0;
			let existing = 0;
			for (const [index, id] of ids.entries()) {
				const workflowId = articleWorkflowId(message.id, targetTable, id, index);
				const result = await ensureArticleWorkflow(env, workflowId, id, targetTable);
				if (result.created) created++;
				else existing++;
			}
			console.info({ tag: 'ARTICLE-QUEUE', msg: 'Ensured workflows', count: ids.length, created, existing });
			message.ack();
		} catch (err) {
			console.error({ tag: 'ARTICLE-QUEUE', msg: 'Error handling message, retrying', error: String(err) });
			message.retry();
		}
	}
}

function articleWorkflowId(messageId: string, targetTable: ProcessableTable, articleId: string, index: number): string {
	return ['article', workflowIdPart(messageId), workflowIdPart(targetTable), String(index), workflowIdPart(articleId)].join('-');
}

function workflowIdPart(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
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
