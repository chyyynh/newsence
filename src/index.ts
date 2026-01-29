import { Env, ScheduledEvent, ExecutionContext, MessageBatch, QueueMessage } from './types';
import { handleHealth, handleStatus, handleManualTrigger, handleSubmitUrl, handleScrapeUrl, handleYouTubeMetadata } from './handlers';
import { handleRSSCron, handleTwitterCron } from './cron';
import { handleArticleQueue } from './queue';
import { NewsenceMonitorWorkflow } from './workflow';

export { NewsenceMonitorWorkflow };

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/health') return handleHealth(env);
		if (url.pathname === '/status') return handleStatus(env);
		if (url.pathname === '/trigger' && request.method === 'POST') return handleManualTrigger(request, env, ctx);
		if (url.pathname === '/submit' && request.method === 'POST') return handleSubmitUrl(request, env, ctx);
		if (url.pathname === '/scrape' && request.method === 'POST') return handleScrapeUrl(request, env);
		if (url.pathname === '/api/youtube/metadata' && request.method === 'GET') return handleYouTubeMetadata(request, env);

		// Manual cron triggers
		if (url.pathname === '/cron/rss' && request.method === 'POST') {
			ctx.waitUntil(handleRSSCron(env, ctx));
			return Response.json({ status: 'started', cron: 'rss-monitor' });
		}
		if (url.pathname === '/cron/twitter' && request.method === 'POST') {
			ctx.waitUntil(handleTwitterCron(env, ctx));
			return Response.json({ status: 'started', cron: 'twitter-monitor' });
		}
		return new Response(
			'Newsence Core Worker\n\n' +
			'Endpoints:\n' +
			'GET  /health\n' +
			'GET  /status\n' +
			'POST /trigger\n' +
			'POST /submit          - Submit URL: {"url": "...", "source?": "..."}\n' +
			'POST /cron/rss\n' +
			'POST /cron/twitter\n',
			{ headers: { 'Content-Type': 'text/plain' } }
		);
	},

	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		console.log(`[CORE] Scheduled: ${event.cron}`);

		if (event.cron === '*/5 * * * *') ctx.waitUntil(handleRSSCron(env, ctx));
		else if (event.cron === '0 */6 * * *') ctx.waitUntil(handleTwitterCron(env, ctx));
	},

	async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
		console.log(`[CORE] Queue: ${batch.queue} (${batch.messages.length} messages)`);
		await handleArticleQueue(batch, env);
	},
};
