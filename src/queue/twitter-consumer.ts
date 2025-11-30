import { Env, ExecutionContext, MessageBatch, QueueMessage } from '../types';

export async function handleTwitterQueue(batch: MessageBatch<QueueMessage>, env: Env, _ctx: ExecutionContext) {
	console.log(`[TWITTER-QUEUE] Received batch of ${batch.messages.length} messages`);

	for (const message of batch.messages) {
		try {
			const body = message.body as QueueMessage | undefined;
			if (!body || body.type !== 'tweet_scraped' || !body.article_id) {
				console.warn('[TWITTER-QUEUE] Unknown/invalid message, acking');
				message.ack();
				continue;
			}

			const instance = await env.MONITOR_WORKFLOW.create({
				params: {
					source: 'twitter',
					article_ids: [body.article_id],
					metadata: {
						trigger_time: new Date().toISOString(),
						message_id: message.id,
						source: body.source,
						url: body.url,
					},
				},
			});

			console.log(`[TWITTER-QUEUE] Started workflow ${instance.id} for tweet ${body.article_id}`);
			message.ack();
		} catch (err) {
			console.error('[TWITTER-QUEUE] Error handling message, retrying:', err);
			message.retry();
		}
	}
}
