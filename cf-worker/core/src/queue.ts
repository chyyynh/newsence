import { Env, MessageBatch, QueueMessage } from './types';

export async function handleArticleQueue(
	batch: MessageBatch<QueueMessage>,
	env: Env
): Promise<void> {
	console.log(`[ARTICLE-QUEUE] Received batch of ${batch.messages.length} messages`);

	for (const message of batch.messages) {
		const body = message.body;

		try {
			if (body.type === 'article_process') {
				await env.MONITOR_WORKFLOW.create({
					params: { article_id: body.article_id, source_type: body.source_type },
				});
				console.log(`[ARTICLE-QUEUE] Created workflow for article ${body.article_id}`);
				message.ack();
			} else if (body.type === 'batch_process') {
				for (const id of body.article_ids) {
					await env.MONITOR_WORKFLOW.create({
						params: { article_id: id, source_type: 'batch' },
					});
				}
				console.log(`[ARTICLE-QUEUE] Created ${body.article_ids.length} workflows (batch from ${body.triggered_by})`);
				message.ack();
			} else {
				console.warn(`[ARTICLE-QUEUE] Unknown message type, acking`);
				message.ack();
			}
		} catch (err) {
			console.error('[ARTICLE-QUEUE] Error handling message, retrying:', err);
			message.retry();
		}
	}
}
