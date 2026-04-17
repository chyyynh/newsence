import { WorkerEntrypoint } from 'cloudflare:workers';
import { handleEmbed } from './app/handlers/embed';
import { handleHealth, handleTestScrape } from './app/handlers/health';
import { handlePreview } from './app/handlers/preview';
import { handleSubmitUrl, type SubmitOutcome, submitUrls } from './app/handlers/submit';
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
	'HTTP endpoints (frontend):\n' +
	'GET  /health\n' +
	'*    /preview                    - Scrape-only\n' +
	'POST /submit                     - Submit URL\n' +
	'POST /embed                      - Generate embeddings\n' +
	'GET  /status/:instanceId         - Workflow status (JSON)\n' +
	'GET  /stream/:instanceId         - Workflow status (SSE)\n';

export default class CoreWorker extends WorkerEntrypoint<Env> {
	override async fetch(request: Request): Promise<Response> {
		return (await routeRequest(request, this.env)) ?? new Response(HELP_TEXT, { headers: { 'Content-Type': 'text/plain' } });
	}

	async scheduled(event: ScheduledEvent, _env?: Env, _ctx?: ExecutionContext): Promise<void> {
		logInfo('CORE', 'Scheduled', { cron: event.cron });
		const ctx = this.ctx;

		if (event.cron === '*/5 * * * *') ctx.waitUntil(handleRSSCron(this.env, ctx));
		else if (event.cron === '0 */6 * * *') ctx.waitUntil(handleTwitterCron(this.env, ctx));
		else if (event.cron === '*/30 * * * *') {
			ctx.waitUntil(handleYouTubeCron(this.env, ctx));
			ctx.waitUntil(handleBilibiliCron(this.env, ctx));
			ctx.waitUntil(handleXiaohongshuCron(this.env, ctx));
		} else if (event.cron === '0 3 * * *') ctx.waitUntil(handleRetryCron(this.env, ctx));
	}

	async queue(batch: MessageBatch<QueueMessage>): Promise<void> {
		logInfo('CORE', 'Queue received', { queue: batch.queue, count: batch.messages.length });
		await handleArticleQueue(batch, this.env);
	}

	// ── RPC: submit URL ──────────────────────────────────────
	async submitUrl(args: {
		url?: string;
		urls?: string[];
		userId?: string;
		visibility?: 'public' | 'private';
	}): Promise<SubmitOutcome> {
		const urls = args.urls ?? (args.url ? [args.url] : []);
		return submitUrls(this.env, {
			urls,
			userId: args.userId,
			visibility: args.visibility,
			rateKey: args.userId ? `user:${args.userId}` : 'rpc:anon',
		});
	}
}
