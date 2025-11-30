import { Env, ExecutionContext } from '../types';
import { processArticlesByIds } from '../queue/article-consumer';

export async function handleArticleDailyCron(env: Env, ctx: ExecutionContext) {
	console.log('[CRON] Article daily processing triggered');
	ctx.waitUntil(processArticlesByIds(env));
}
