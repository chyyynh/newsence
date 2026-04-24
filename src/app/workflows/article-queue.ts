import { ARTICLES_TABLE, createDbClient } from '../../infra/db';
import { logError, logInfo, logWarn } from '../../infra/log';
import type { Env, MessageBatch, QueueMessage } from '../../models/types';

const SOURCE_TYPE_BATCH_SIZE = 200;
const SOURCE_TYPE_FALLBACK = 'default';

async function fetchSourceTypeMap(articleIds: string[], env: Env): Promise<Map<string, string>> {
	if (articleIds.length === 0) return new Map();

	const sourceTypes = new Map<string, string>();
	const db = await createDbClient(env);

	try {
		for (let i = 0; i < articleIds.length; i += SOURCE_TYPE_BATCH_SIZE) {
			const batchIds = articleIds.slice(i, i + SOURCE_TYPE_BATCH_SIZE);
			try {
				const result = await db.query(`SELECT id, source_type FROM ${ARTICLES_TABLE} WHERE id = ANY($1)`, [batchIds]);
				for (const row of result.rows) {
					if (row.id && row.source_type) sourceTypes.set(row.id, row.source_type);
				}
			} catch (error) {
				logWarn('ARTICLE-QUEUE', 'Failed to fetch source types', { error: String(error) });
			}
		}
	} finally {
		await db.end();
	}

	return sourceTypes;
}

export async function handleArticleQueue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
	logInfo('ARTICLE-QUEUE', 'Received batch', { count: batch.messages.length });

	for (const message of batch.messages) {
		const body = message.body;

		try {
			if (body.type === 'article_process') {
				await env.MONITOR_WORKFLOW.create({
					params: {
						article_id: body.article_id,
						source_type: body.source_type,
						...(body.target_table ? { target_table: body.target_table } : {}),
					},
				});
				logInfo('ARTICLE-QUEUE', 'Created workflow for article', { article_id: body.article_id });
				message.ack();
			} else if (body.type === 'batch_process') {
				const sourceTypeMap = await fetchSourceTypeMap(body.article_ids, env);
				for (const id of body.article_ids) {
					const sourceType = sourceTypeMap.get(id) ?? SOURCE_TYPE_FALLBACK;
					await env.MONITOR_WORKFLOW.create({
						params: {
							article_id: id,
							source_type: sourceType,
							...(body.target_table ? { target_table: body.target_table } : {}),
						},
					});
				}
				logInfo('ARTICLE-QUEUE', 'Created workflows (batch)', { count: body.article_ids.length, triggered_by: body.triggered_by });
				message.ack();
			} else {
				logWarn('ARTICLE-QUEUE', 'Unknown message type, acking');
				message.ack();
			}
		} catch (err) {
			logError('ARTICLE-QUEUE', 'Error handling message, retrying', { error: String(err) });
			message.retry();
		}
	}
}
