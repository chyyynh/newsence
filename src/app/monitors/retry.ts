import { ARTICLES_TABLE, createDbClient } from '../../infra/db';
import { logInfo } from '../../infra/log';
import type { Env, ExecutionContext } from '../../models/types';

// ─────────────────────────────────────────────────────────────
// Retry Failed Articles
// ─────────────────────────────────────────────────────────────

const RETRY_BATCH_SIZE = 20;

export async function handleRetryCron(env: Env, _ctx: ExecutionContext): Promise<void> {
	logInfo('RETRY', 'start');
	const db = await createDbClient(env);
	try {
		const table = ARTICLES_TABLE;
		const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

		// AI processing failures
		const aiResult = await db.query(
			`SELECT id FROM ${table} WHERE scraped_date >= $1 AND (title_cn IS NULL OR summary_cn IS NULL OR embedding IS NULL)`,
			[since],
		);

		// Translation failures (content exists but content_cn is null)
		const translationResult = await db.query(
			`SELECT id FROM ${table} WHERE scraped_date >= $1 AND content IS NOT NULL AND content_cn IS NULL`,
			[since],
		);

		const ids = [
			...new Set([
				...(aiResult.rows as Array<{ id: string }>).map((r) => r.id),
				...(translationResult.rows as Array<{ id: string }>).map((r) => r.id),
			]),
		];

		if (!ids.length) return logInfo('RETRY', 'No incomplete articles');
		for (let i = 0; i < ids.length; i += RETRY_BATCH_SIZE) {
			await env.ARTICLE_QUEUE.send({
				type: 'batch_process',
				article_ids: ids.slice(i, i + RETRY_BATCH_SIZE),
				triggered_by: 'retry_cron',
			});
		}
		logInfo('RETRY', 'Queued articles for retry', {
			count: ids.length,
			batches: Math.ceil(ids.length / RETRY_BATCH_SIZE),
		});
	} finally {
		await db.end();
	}
}
