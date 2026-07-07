import { USER_FILES_TABLE } from '@core-shared/article-store';
import { INTERNAL_CORS_HEADERS, jsonData, jsonError, parseJsonBody, requireAuth } from '@core-shared/auth';
import type { Env } from '@core-shared/types';
import { handleIngest } from '@ingest/handlers/ingest';
import { handleScrape, handleScrapeJobCreate, handleScrapeJobStatus } from '@ingest/handlers/scrape';
import { enqueueArticleBatchProcess, handleRetryCron } from '@ingest/workflows/queue';
import { relatedCorpusArticleIds, searchCorpusArticleRanks } from '../corpus';
import { handleExportCollectionOkf } from '../okf';
import { handleEntityQuality, handlePruneOrphanEntities, handleRepairEntityLinks } from './entity-maintenance';

type RouteHandler = (request: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;

const POST_ROUTES: Record<string, RouteHandler> = {
	'/search': handleSearch,
	'/search/related': handleRelated,
	'/ingest': handleIngest,
	'/retry': handleRetry,
	'/entities/prune-orphans': handlePruneOrphanEntities,
	'/entities/quality': handleEntityQuality,
	'/entities/repair-links': handleRepairEntityLinks,
	'/okf/collections/export': handleExportCollectionOkf,
	'/scrape': handleScrape,
	'/scrape/jobs': handleScrapeJobCreate,
};

const SCRAPE_PREFLIGHT_ROUTES = new Set(['/scrape', '/scrape/jobs']);
const INTERNAL_PREFLIGHT_ROUTES = new Set(Object.keys(POST_ROUTES).filter((route) => !SCRAPE_PREFLIGHT_ROUTES.has(route)));
const WORKFLOW_STREAM_INTERVAL_MS = 3000;
const SCRAPE_JOB_ROUTE = new URLPattern({ pathname: '/scrape/jobs/:jobId' });
const WORKFLOW_STREAM_ROUTE = new URLPattern({ pathname: '/stream/:instanceId' });
const TERMINAL_WORKFLOW_STATUSES = new Set(['complete', 'errored', 'error', 'terminated', 'timeout']);

type WorkflowStreamEvent = {
	error?: unknown;
	output?: unknown;
	status: string;
};

const HELP_TEXT =
	'Newsence Core Worker\n\n' +
	'HTTP endpoints:\n' +
	'GET  /health\n' +
	'POST /ingest                              - Ingest URL (JSON), image URL (JSON), or user-uploaded blob (multipart)\n' +
	'POST /retry                               - Internal: enqueue article/user_file workflow retries\n' +
	'POST /entities/prune-orphans              - Internal: delete entities with no article_entities links\n' +
	'POST /entities/quality                    - Internal: entity extraction coverage/sync/type quality snapshot\n' +
	'POST /entities/repair-links               - Internal: repair/normalize article_entities links from stored entities JSONB; optional {sourceType}\n' +
	'POST /okf/collections/export              - Export a collection as an OKF v0.1 bundle tar.gz (internal token) -> gzip stream\n' +
	'POST /scrape                              - Sync extraction: {url} JSON or raw bytes -> NormalizedContent {markdown,text,metadata,status}\n' +
	'POST /scrape/jobs                         - Async parse job (non-persisting): {url} or raw bytes -> {jobId}\n' +
	'GET  /scrape/jobs/:id                     - Poll parse job -> {status, result?, error?}\n' +
	'POST /search                              - Hybrid corpus ranking (internal token) -> {success,data:{results}}\n' +
	'POST /search/related                      - pgvector neighbours of a seed (internal token) -> {success,data:{ids}}\n' +
	'GET  /stream/:instanceId                  - Workflow status (SSE, internal token)\n';

async function handleSearch(request: Request, env: Env): Promise<Response> {
	const unauth = await requireAuth(request, env, INTERNAL_CORS_HEADERS);
	if (unauth) return unauth;

	const body = await parseJsonBody<{ query?: string; limit?: number }>(request, INTERNAL_CORS_HEADERS);
	if (body instanceof Response) return body;

	if (!body.query?.trim()) {
		return jsonData({ results: [] }, INTERNAL_CORS_HEADERS);
	}

	try {
		const results = await searchCorpusArticleRanks(env, { query: body.query, limit: body.limit });
		return jsonData({ results }, INTERNAL_CORS_HEADERS);
	} catch (error) {
		console.error({ tag: 'SEARCH', msg: 'hybrid search failed', error: error instanceof Error ? error.message : String(error) });
		return jsonError('SEARCH_FAILED', 'Search failed', 500, INTERNAL_CORS_HEADERS);
	}
}

async function handleRelated(request: Request, env: Env): Promise<Response> {
	const unauth = await requireAuth(request, env, INTERNAL_CORS_HEADERS);
	if (unauth) return unauth;

	const body = await parseJsonBody<{ id?: string; type?: string; limit?: number; offset?: number }>(request, INTERNAL_CORS_HEADERS);
	if (body instanceof Response) return body;

	if (!body.id?.trim()) {
		return jsonError('BAD_REQUEST', 'Missing seed id', 400, INTERNAL_CORS_HEADERS);
	}
	const type = body.type === 'user_file' ? 'user_file' : 'article';

	try {
		const ids = await relatedCorpusArticleIds(env, { seed: { id: body.id, type }, limit: body.limit, offset: body.offset });
		return jsonData({ ids }, INTERNAL_CORS_HEADERS);
	} catch (error) {
		console.error({ tag: 'SEARCH', msg: 'related search failed', error: error instanceof Error ? error.message : String(error) });
		return jsonError('SEARCH_FAILED', 'Related search failed', 500, INTERNAL_CORS_HEADERS);
	}
}

async function handleRetry(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const unauth = await requireAuth(request, env, INTERNAL_CORS_HEADERS);
	if (unauth) return unauth;

	const body = await parseJsonBody<{ articleIds?: string[]; userFileIds?: string[] }>(request, INTERNAL_CORS_HEADERS);
	if (body instanceof Response) return body;

	const articleIds = body.articleIds?.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()) ?? [];
	const userFileIds = body.userFileIds?.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()) ?? [];

	if (articleIds.length || userFileIds.length) {
		if (articleIds.length) await enqueueArticleBatchProcess(env, articleIds);
		if (userFileIds.length) await enqueueArticleBatchProcess(env, userFileIds, USER_FILES_TABLE);
		return jsonData({ articles: articleIds.length, userFiles: userFileIds.length }, INTERNAL_CORS_HEADERS);
	}

	ctx.waitUntil(handleRetryCron(env));
	return jsonData({ queued: true }, INTERNAL_CORS_HEADERS);
}

async function handleWorkflowStream(request: Request, instanceId: string, env: Env): Promise<Response> {
	const unauth = await requireAuth(request, env);
	if (unauth) return unauth;

	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const writeEvent = (data: WorkflowStreamEvent) => {
				if (request.signal.aborted) return false;
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
				return true;
			};
			try {
				const instance = await env.MONITOR_WORKFLOW.get(instanceId);
				while (!request.signal.aborted) {
					const { status, error, output } = await instance.status();
					const streamStatus = String(status);
					const isTerminal = TERMINAL_WORKFLOW_STATUSES.has(streamStatus);

					if (streamStatus === 'complete') {
						writeEvent({ status: 'complete', output });
						return;
					}

					if (!writeEvent({ status: streamStatus, error })) return;
					if (isTerminal) return;
					await scheduler.wait(WORKFLOW_STREAM_INTERVAL_MS, { signal: request.signal }).catch(() => undefined);
				}
			} catch (err) {
				if (!request.signal.aborted) writeEvent({ status: 'error', error: String(err) });
			} finally {
				controller.close();
			}
		},
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no',
		},
	});
}

export function routeRequest(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
	const { pathname } = new URL(request.url);
	const { method } = request;

	if (pathname === '/health') {
		return Response.json({
			status: 'ok',
			worker: 'newsence-core',
			timestamp: new Date().toISOString(),
		});
	}
	if (method === 'OPTIONS') {
		if (SCRAPE_PREFLIGHT_ROUTES.has(pathname)) return POST_ROUTES[pathname](request, env, ctx);
		if (INTERNAL_PREFLIGHT_ROUTES.has(pathname)) return new Response(null, { headers: INTERNAL_CORS_HEADERS });

		const id = SCRAPE_JOB_ROUTE.exec({ pathname })?.pathname.groups.jobId;
		if (id) return handleScrapeJobStatus(request, id, env);
	}

	if (method === 'POST') {
		const handler = POST_ROUTES[pathname];
		if (handler) return handler(request, env, ctx);
	}

	if (method === 'GET') {
		const instanceId = WORKFLOW_STREAM_ROUTE.exec({ pathname })?.pathname.groups.instanceId;
		if (instanceId) return handleWorkflowStream(request, instanceId, env);

		const id = SCRAPE_JOB_ROUTE.exec({ pathname })?.pathname.groups.jobId;
		if (id) return handleScrapeJobStatus(request, id, env);
	}

	return new Response(HELP_TEXT, { headers: { 'Content-Type': 'text/plain' } });
}
