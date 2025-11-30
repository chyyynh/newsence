import { Env, ExecutionContext, MessageBatch, QueueMessage } from '../types';

export async function handleRSSQueue(batch: MessageBatch<QueueMessage>, env: Env, _ctx: ExecutionContext) {
	console.log(`[RSS-QUEUE] Received batch of ${batch.messages.length} messages`);

	for (const message of batch.messages) {
		try {
			const body = message.body as QueueMessage | undefined;
			if (!body || body.type !== 'article_scraped' || !body.article_id) {
				console.warn('[RSS-QUEUE] Unknown/invalid message, acking');
				message.ack();
				continue;
			}

			const instance = await env.MONITOR_WORKFLOW.create({
				params: {
					source: body.source_type || 'rss',
					article_ids: [body.article_id],
					metadata: {
						trigger_time: new Date().toISOString(),
						message_id: message.id,
						source: body.source,
						url: body.url,
					},
				},
			});

			console.log(`[RSS-QUEUE] Started workflow ${instance.id} for article ${body.article_id}`);
			message.ack();
		} catch (err) {
			console.error('[RSS-QUEUE] Error handling message, retrying:', err);
			message.retry();
		}
	}
}
