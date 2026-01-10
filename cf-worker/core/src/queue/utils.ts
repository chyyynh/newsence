import { Env, ExecutionContext, MessageBatch, QueueMessage } from '../types';

type QueueSource = 'rss' | 'twitter';

interface QueueConfig {
	source: QueueSource;
	messageType: string;
	logPrefix: string;
}

const QUEUE_CONFIGS: Record<QueueSource, QueueConfig> = {
	rss: { source: 'rss', messageType: 'article_scraped', logPrefix: 'RSS-QUEUE' },
	twitter: { source: 'twitter', messageType: 'tweet_scraped', logPrefix: 'TWITTER-QUEUE' },
};

export async function handleSourceQueue(
	batch: MessageBatch<QueueMessage>,
	env: Env,
	_ctx: ExecutionContext,
	source: QueueSource
): Promise<void> {
	const config = QUEUE_CONFIGS[source];
	console.log(`[${config.logPrefix}] Received batch of ${batch.messages.length} messages`);

	for (const message of batch.messages) {
		try {
			const body = message.body as QueueMessage | undefined;
			if (!body || body.type !== config.messageType || !body.article_id) {
				console.warn(`[${config.logPrefix}] Unknown/invalid message, acking`);
				message.ack();
				continue;
			}

			const instance = await env.MONITOR_WORKFLOW.create({
				params: {
					source: config.source,
					article_ids: [body.article_id],
					metadata: {
						trigger_time: new Date().toISOString(),
						message_id: message.id,
						source: body.source,
						url: body.url,
					},
				},
			});

			console.log(`[${config.logPrefix}] Started workflow ${instance.id} for ${source === 'twitter' ? 'tweet' : 'article'} ${body.article_id}`);
			message.ack();
		} catch (err) {
			console.error(`[${config.logPrefix}] Error handling message, retrying:`, err);
			message.retry();
		}
	}
}
