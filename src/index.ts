import {
	handleBotGetUnsorted,
	handleBotListArticles,
	handleBotLookup,
	handleTelegramAddToCollection,
	handleTelegramCollections,
	handleTelegramLookup,
} from './app/handlers/bot-api';
import { handleEmbed } from './app/handlers/embed';
import { handleHealth, handleTestScrape } from './app/handlers/health';
import { handlePreview } from './app/handlers/preview';
import { handleSubmitUrl } from './app/handlers/submit';
import { handleWorkflowStatus, handleWorkflowStream } from './app/handlers/workflow-status';
import { handleRetryCron } from './app/monitors/retry';
import { handleArticleQueue, NewsenceMonitorWorkflow } from './domain/workflow';
import { logInfo } from './infra/log';
import type { Env, ExecutionContext, MessageBatch, QueueMessage, ScheduledEvent } from './models/types';
import { handleBilibiliCron } from './platforms/bilibili/monitor';
import { handleRSSCron } from './platforms/rss/monitor';
import { handleTwitterCron } from './platforms/twitter/monitor';
import { handleXiaohongshuCron } from './platforms/xiaohongshu/monitor';
import { handleYouTubeCron } from './platforms/youtube/monitor';

export { NewsenceMonitorWorkflow };

type RouteHandler = (request: Request, env: Env) => Response | Promise<Response>;

const POST_ROUTES: Record<string, RouteHandler> = {
	'/embed': handleEmbed,
	'/submit': handleSubmitUrl,
	'/bot/lookup': handleBotLookup,
	'/bot/get-unsorted': handleBotGetUnsorted,
	'/bot/list-articles': handleBotListArticles,
	'/telegram/lookup': handleTelegramLookup,
	'/telegram/collections': handleTelegramCollections,
	'/telegram/add-to-collection': handleTelegramAddToCollection,
};

function routePrefixGet(pathname: string, env: Env): Response | Promise<Response> | null {
	if (pathname.startsWith('/status/')) {
		const id = pathname.slice('/status/'.length);
		if (id) return handleWorkflowStatus(id, env);
	}
	if (pathname.startsWith('/stream/')) {
		const id = pathname.slice('/stream/'.length);
		if (id) return handleWorkflowStream(id, env);
	}
	return null;
}

function routeRequest(request: Request, env: Env): Response | Promise<Response> | null {
	const { pathname } = new URL(request.url);

	if (pathname === '/health') return handleHealth(env);
	if (pathname === '/preview') return handlePreview(request, env);
	if (pathname === '/scrape') return handleTestScrape(request, env);

	if (request.method === 'OPTIONS' && pathname === '/embed') return handleEmbed(request, env);

	if (request.method === 'POST') {
		const handler = POST_ROUTES[pathname];
		if (handler) return handler(request, env);
	}

	if (request.method === 'GET') return routePrefixGet(pathname, env);

	return null;
}

const HELP_TEXT =
	'Newsence Core Worker\n\n' +
	'Endpoints:\n' +
	'GET  /health\n' +
	'*    /preview                    - Scrape-only: {"url":"..."} or {"message":"..."}\n' +
	'POST /submit                     - Submit URL: {"url": "..."}\n' +
	'GET  /status/:instanceId         - Workflow status (JSON)\n' +
	'GET  /stream/:instanceId         - Workflow status (SSE)\n' +
	'POST /telegram/lookup            - Lookup Telegram account binding\n' +
	'POST /telegram/collections       - Fetch user collections\n' +
	'POST /telegram/add-to-collection - Add article to collection\n';

export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		return (await routeRequest(request, env)) ?? new Response(HELP_TEXT, { headers: { 'Content-Type': 'text/plain' } });
	},

	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		logInfo('CORE', 'Scheduled', { cron: event.cron });

		if (event.cron === '*/5 * * * *') ctx.waitUntil(handleRSSCron(env, ctx));
		else if (event.cron === '0 */6 * * *') ctx.waitUntil(handleTwitterCron(env, ctx));
		else if (event.cron === '*/30 * * * *') {
			ctx.waitUntil(handleYouTubeCron(env, ctx));
			ctx.waitUntil(handleBilibiliCron(env, ctx));
			ctx.waitUntil(handleXiaohongshuCron(env, ctx));
		} else if (event.cron === '0 3 * * *') ctx.waitUntil(handleRetryCron(env, ctx));
	},

	async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
		logInfo('CORE', 'Queue received', { queue: batch.queue, count: batch.messages.length });
		await handleArticleQueue(batch, env);
	},
};
