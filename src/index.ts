import {
	handleHealth,
	handleSubmitUrl,
	handleTelegramAddToCollection,
	handleTelegramCollections,
	handleTelegramLookup,
	handleTestScrape,
	handleWorkflowStatus,
	handleWorkflowStream,
} from './app/http';
import { handleRetryCron, handleRSSCron, handleTwitterCron } from './app/schedule';
import { handleArticleQueue, NewsenceMonitorWorkflow } from './domain/workflow';
import { logInfo } from './infra/log';
import type { Env, ExecutionContext, MessageBatch, QueueMessage, ScheduledEvent } from './models/types';

export { NewsenceMonitorWorkflow };

type RouteHandler = (request: Request, env: Env) => Response | Promise<Response>;

const POST_ROUTES: Record<string, RouteHandler> = {
	'/submit': handleSubmitUrl,
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
	if (pathname === '/scrape') return handleTestScrape(request, env);

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
		else if (event.cron === '0 3 * * *') ctx.waitUntil(handleRetryCron(env, ctx));
	},

	async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
		logInfo('CORE', 'Queue received', { queue: batch.queue, count: batch.messages.length });
		await handleArticleQueue(batch, env);
	},
};
