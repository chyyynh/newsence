import { Env, ScheduledEvent, ExecutionContext, MessageBatch, QueueMessage } from './models/types';
import { handleHealth, handleSubmitUrl } from './app/http';
import { handleRSSCron, handleTwitterCron, handleRetryCron } from './app/schedule';
import { handleArticleQueue, NewsenceMonitorWorkflow } from './domain/workflow';

export { NewsenceMonitorWorkflow };

export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/health') return handleHealth(env);
		if (url.pathname === '/submit' && request.method === 'POST') return handleSubmitUrl(request, env);

		return new Response(
			'Newsence Core Worker\n\n' +
			'Endpoints:\n' +
			'GET  /health\n' +
			'POST /submit          - Submit URL: {"url": "..."}\n',
			{ headers: { 'Content-Type': 'text/plain' } }
		);
	},

	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		console.log(`[CORE] Scheduled: ${event.cron}`);

		if (event.cron === '*/5 * * * *') ctx.waitUntil(handleRSSCron(env, ctx));
		else if (event.cron === '0 */6 * * *') ctx.waitUntil(handleTwitterCron(env, ctx));
		else if (event.cron === '0 3 * * *') ctx.waitUntil(handleRetryCron(env, ctx));
	},

	async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
		console.log(`[CORE] Queue: ${batch.queue} (${batch.messages.length} messages)`);
		await handleArticleQueue(batch, env);
	},
};
