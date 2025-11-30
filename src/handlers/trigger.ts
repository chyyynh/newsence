import { processArticlesByIds } from '../queue/article-consumer';
import { Env, ExecutionContext } from '../types';

type TriggerBody = {
	article_ids?: string[];
	source?: string;
	triggered_by?: string;
};

export async function handleManualTrigger(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	let body: TriggerBody = {};

	try {
		body = (await request.json()) as TriggerBody;
	} catch {
		// Ignore JSON parse error and treat as empty body
	}

	const articleIds = body.article_ids || [];
	console.log(`[TRIGGER] Manual trigger received for ${articleIds.length} articles from ${body.triggered_by || 'manual'}`);

	ctx.waitUntil(processArticlesByIds(env, articleIds));

	return new Response(JSON.stringify({
		status: 'started',
		message: 'Article processing started',
		article_count: articleIds.length,
		processing_mode: articleIds.length > 0 ? 'specific_articles' : 'recent_unprocessed'
	}), {
		headers: { 'Content-Type': 'application/json' }
	});
}
