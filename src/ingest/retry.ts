import { getIncompleteWorkflowTargetIds, USER_FILES_TABLE } from '@shared/article-store';
import { withDbClient } from '@shared/db';
import type { Env, ExecutionContext } from '@shared/types';
import { enqueueArticleBatchProcess } from '@shared/workflow-queue';

// ─────────────────────────────────────────────────────────────
// Retry Failed Articles
// ─────────────────────────────────────────────────────────────

const RETRY_BATCH_SIZE = 20;

export async function handleRetryCron(env: Env, _ctx: ExecutionContext): Promise<void> {
	console.info({ tag: 'RETRY', msg: 'start' });
	await withDbClient(env, async (db) => {
		const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
		const { articleIds, userFileIds } = await getIncompleteWorkflowTargetIds(db, since);
		const total = articleIds.length + userFileIds.length;

		if (!total) return console.info({ tag: 'RETRY', msg: 'No incomplete articles' });
		for (let i = 0; i < articleIds.length; i += RETRY_BATCH_SIZE) {
			await enqueueArticleBatchProcess(env, articleIds.slice(i, i + RETRY_BATCH_SIZE));
		}
		for (let i = 0; i < userFileIds.length; i += RETRY_BATCH_SIZE) {
			await enqueueArticleBatchProcess(env, userFileIds.slice(i, i + RETRY_BATCH_SIZE), USER_FILES_TABLE);
		}
		console.info({
			tag: 'RETRY',
			msg: 'Queued articles for retry',
			articles: articleIds.length,
			userFiles: userFileIds.length,
			batches: Math.ceil(articleIds.length / RETRY_BATCH_SIZE) + Math.ceil(userFileIds.length / RETRY_BATCH_SIZE),
		});
	});
}
