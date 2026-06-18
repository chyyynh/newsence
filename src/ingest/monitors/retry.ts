import { ARTICLES_TABLE, createDbClient, USER_FILES_TABLE } from '@shared/db';
import type { Env, ExecutionContext } from '@shared/types';

// ─────────────────────────────────────────────────────────────
// Retry Failed Articles
// ─────────────────────────────────────────────────────────────

const RETRY_BATCH_SIZE = 20;

export async function handleRetryCron(env: Env, _ctx: ExecutionContext): Promise<void> {
	console.info({ tag: 'RETRY', msg: 'start' });
	const db = await createDbClient(env);
	try {
		const table = ARTICLES_TABLE;
		const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

		const articleResult = await db.query(
			`SELECT id FROM ${table} WHERE scraped_date >= $1 AND (title_cn IS NULL OR summary_cn IS NULL OR embedding IS NULL)`,
			[since],
		);

		const userFileResult = await db.query(
			`SELECT id FROM ${USER_FILES_TABLE}
			 WHERE created_at >= $1
			   AND (
			     (resource_kind = 'url' AND (title_cn IS NULL OR summary_cn IS NULL OR embedding IS NULL))
			     OR (
			       resource_kind = 'blob'
			       AND file_type = 'application/pdf'
			       AND (metadata->'extraction'->>'status') IS DISTINCT FROM 'failed'
			       AND (extracted_text IS NULL OR embedding IS NULL)
			     )
			   )`,
			[since],
		);

		const articleIds = [...new Set((articleResult.rows as Array<{ id: string }>).map((r) => r.id))];
		const userFileIds = [...new Set((userFileResult.rows as Array<{ id: string }>).map((r) => r.id))];
		const total = articleIds.length + userFileIds.length;

		if (!total) return console.info({ tag: 'RETRY', msg: 'No incomplete articles' });
		for (let i = 0; i < articleIds.length; i += RETRY_BATCH_SIZE) {
			await env.ARTICLE_QUEUE.send({
				type: 'batch_process',
				article_ids: articleIds.slice(i, i + RETRY_BATCH_SIZE),
				triggered_by: 'retry_cron',
			});
		}
		for (let i = 0; i < userFileIds.length; i += RETRY_BATCH_SIZE) {
			await env.ARTICLE_QUEUE.send({
				type: 'batch_process',
				article_ids: userFileIds.slice(i, i + RETRY_BATCH_SIZE),
				triggered_by: 'retry_cron',
				target_table: USER_FILES_TABLE,
			});
		}
		console.info({
			tag: 'RETRY',
			msg: 'Queued articles for retry',
			articles: articleIds.length,
			userFiles: userFileIds.length,
			batches: Math.ceil(articleIds.length / RETRY_BATCH_SIZE) + Math.ceil(userFileIds.length / RETRY_BATCH_SIZE),
		});
	} finally {
		await db.end();
	}
}
