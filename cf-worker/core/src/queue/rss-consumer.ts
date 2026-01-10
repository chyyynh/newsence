import { Env, ExecutionContext, MessageBatch, QueueMessage } from '../types';
import { handleSourceQueue } from './utils';

export function handleRSSQueue(batch: MessageBatch<QueueMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
	return handleSourceQueue(batch, env, ctx, 'rss');
}
