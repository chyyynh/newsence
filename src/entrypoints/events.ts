import { handleRetryCron } from '@ingest/monitors/retry';
import { handleRSSCron } from '@ingest/platforms/rss/monitor';
import { handleTwitterCron } from '@ingest/platforms/twitter/monitor';
import { handleYouTubeCron } from '@ingest/platforms/youtube/monitor';
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
			for (const id of ids) {
				await env.MONITOR_WORKFLOW.create({
					params: {
						article_id: id,
						target_table: targetTable,
					},
				});
			}
			console.info({ tag: 'ARTICLE-QUEUE', msg: 'Created workflows', count: ids.length });
			message.ack();
		} catch (err) {
			console.error({ tag: 'ARTICLE-QUEUE', msg: 'Error handling message, retrying', error: String(err) });
			message.retry();
		}
	}
}
