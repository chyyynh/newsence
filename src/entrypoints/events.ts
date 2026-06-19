import { handleRSSCron } from '@ingest/platforms/rss/monitor';
import { handleTwitterCron } from '@ingest/platforms/twitter/monitor';
import { handleYouTubeCron } from '@ingest/platforms/youtube/monitor';
import { handleRetryCron } from '@ingest/retry';
import type { Env, ExecutionContext, MessageBatch, QueueMessage, ScheduledEvent, WorkflowQueueTarget } from '@shared/types';
import { ensureWorkflowForQueueTarget } from '@shared/workflow-queue';

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
			let created = 0;
			let existing = 0;
			for (const [index, target] of targets.entries()) {
				const result = await ensureWorkflowForQueueTarget(env, message.id, target, index);
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
	return body.type === 'workflow_process' ? [body.target] : body.targets;
}
