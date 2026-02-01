import { Env, MessageBatch, QueueMessage } from './types';
import { getSupabaseClient, getArticlesTable } from './utils/supabase';

const SOURCE_TYPE_BATCH_SIZE = 200;
const SOURCE_TYPE_FALLBACK = 'default';

async function fetchSourceTypeMap(articleIds: string[], env: Env): Promise<Map<string, string>> {
	if (articleIds.length === 0) return new Map();

	const supabase = getSupabaseClient(env);
	const table = getArticlesTable(env);
	const sourceTypes = new Map<string, string>();

	for (let i = 0; i < articleIds.length; i += SOURCE_TYPE_BATCH_SIZE) {
		const batchIds = articleIds.slice(i, i + SOURCE_TYPE_BATCH_SIZE);
		const { data, error } = await supabase.from(table).select('id, source_type').in('id', batchIds);
		if (error) {
			console.warn('[ARTICLE-QUEUE] Failed to fetch source types:', error);
			continue;
		}
		for (const row of data ?? []) {
			if (row.id && row.source_type) sourceTypes.set(row.id, row.source_type);
		}
	}

	return sourceTypes;
}

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
				const sourceTypeMap = await fetchSourceTypeMap(body.article_ids, env);
				for (const id of body.article_ids) {
					const sourceType = sourceTypeMap.get(id) ?? SOURCE_TYPE_FALLBACK;
					await env.MONITOR_WORKFLOW.create({
						params: { article_id: id, source_type: sourceType },
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
