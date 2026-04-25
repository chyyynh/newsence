import { handleArticleQueue } from '../app/workflows/article-queue';
import { logInfo } from '../infra/log';
import type { Env, MessageBatch, QueueMessage } from '../models/types';

export async function handleQueue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
	logInfo('CORE', 'Queue received', { queue: batch.queue, count: batch.messages.length });
	await handleArticleQueue(batch, env);
}
