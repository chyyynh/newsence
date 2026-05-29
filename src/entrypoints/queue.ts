import { handleArticleQueue } from '@ingest/workflows/article-queue';
import { logInfo } from '@shared/log';
import type { Env, MessageBatch, QueueMessage } from '@shared/types';

export async function handleQueue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
	logInfo('CORE', 'Queue received', { queue: batch.queue, count: batch.messages.length });
	await handleArticleQueue(batch, env);
}
