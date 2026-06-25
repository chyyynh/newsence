import { handleIngest } from '@ingest/handlers/ingest';
import { handleScrape, handleScrapeJobCreate, handleScrapeJobStatus } from '@ingest/handlers/scrape';
import { handleRetryCron } from '@ingest/retry';
import { handleDeleteAsset } from '@media/delete';
import { handleProxy } from '@media/proxy';
import { handleR2Asset } from '@media/r2-asset';
import { USER_FILES_TABLE } from '@shared/article-store';
import { jsonData, jsonError, parseJsonBody, requireAuth } from '@shared/auth';
import type { Env, ExecutionContext } from '@shared/types';
import { enqueueArticleBatchProcess } from '@shared/workflow-queue';
import { rankCorpusArticleIds, relatedCorpusArticleIds } from '../corpus';

type RouteHandler = (request: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;

const INTERNAL_CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, X-Internal-Token, Authorization',
};

const SEARCH_LIMIT_MAX = 500;

const POST_ROUTES: Record<string, RouteHandler> = {
	'/search': (req, env) => handleSearch(req, env),
	'/search/related': (req, env) => handleRelated(req, env),
	'/ingest': (req, env) => handleIngest(req, env),
	'/retry': (req, env, ctx) => handleRetry(req, env, ctx),
	'/scrape': (req, env) => handleScrape(req, env),
	'/scrape/jobs': (req, env) => handleScrapeJobCreate(req, env),
	'/media/delete': (req, env) => handleDeleteAsset(req, env),
};

const OPTIONS_ROUTES: Record<string, RouteHandler> = {
	'/search': (req, env) => handleSearch(req, env),
	'/search/related': (req, env) => handleRelated(req, env),
	'/scrape': (req, env) => handleScrape(req, env),
	'/scrape/jobs': (req, env) => handleScrapeJobCreate(req, env),
};

const HELP_TEXT =
	'Newsence Core Worker\n\n' +
	'HTTP endpoints (frontend):\n' +
	'GET  /health\n' +
	'POST /ingest                              - Ingest URL (JSON), image URL (JSON), or user-uploaded blob (multipart)\n' +
	'POST /retry                               - Internal: enqueue article/user_file workflow retries\n' +
	'POST /scrape                              - Sync extraction: {url} JSON or raw bytes -> NormalizedContent {markdown,text,metadata,status}\n' +
	'POST /scrape/jobs                         - Async parse job (non-persisting): {url} or raw bytes -> {jobId}\n' +
	'GET  /scrape/jobs/:id                     - Poll parse job -> {status, result?, error?}\n' +
	'POST /search                              - Hybrid corpus ranking (internal token) -> {success,data:{results}}\n' +
	'POST /search/related                      - pgvector neighbours of a seed (internal token) -> {success,data:{ids}}\n' +
	'POST /media/delete                        - Batch-delete user-file R2 objects by storage key (#162) -> {success,data}\n' +
	'GET  /stream/:instanceId                  - Workflow status (SSE, internal token)\n' +
	'\nSigned media:\n' +
	'GET  /media/external/{options}/{mediaUrl} - Upstream image/video passthrough with edge cache\n' +
	'GET  /media/asset/{key}?sig=&exp=         - Authenticated R2 asset\n';

function scrapeJobId(pathname: string): string | null {
	if (!pathname.startsWith('/scrape/jobs/')) return null;
	return pathname.slice('/scrape/jobs/'.length) || null;
}

function health(): Response {
	return Response.json({
		status: 'ok',
		worker: 'newsence-core',
		timestamp: new Date().toISOString(),
	});
}

async function handleSearch(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { headers: INTERNAL_CORS_HEADERS });

	const unauth = await requireAuth(request, env, INTERNAL_CORS_HEADERS);
	if (unauth) return unauth;

	const body = await parseJsonBody<{ query?: string; limit?: number }>(request, INTERNAL_CORS_HEADERS);
	if (body instanceof Response) return body;

	const query = body.query?.trim();
	if (!query) {
		return jsonData({ results: [] }, INTERNAL_CORS_HEADERS);
	}
	const limit = Math.min(Math.max(Math.trunc(body.limit ?? 100), 1), SEARCH_LIMIT_MAX);

	try {
		const results = await rankCorpusArticleIds(env, query, limit);
		return jsonData({ results }, INTERNAL_CORS_HEADERS);
	} catch (error) {
		console.error({ tag: 'SEARCH', msg: 'hybrid search failed', error: error instanceof Error ? error.message : String(error) });
		return jsonError('SEARCH_FAILED', 'Search failed', 500, INTERNAL_CORS_HEADERS);
	}
}

async function handleRelated(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { headers: INTERNAL_CORS_HEADERS });

	const unauth = await requireAuth(request, env, INTERNAL_CORS_HEADERS);
	if (unauth) return unauth;

	const body = await parseJsonBody<{ id?: string; type?: string; limit?: number; offset?: number }>(request, INTERNAL_CORS_HEADERS);
	if (body instanceof Response) return body;

	const id = body.id?.trim();
	const type = body.type === 'user_file' ? 'user_file' : 'article';
	if (!id) {
		return jsonError('BAD_REQUEST', 'Missing seed id', 400, INTERNAL_CORS_HEADERS);
	}
	const limit = Math.min(Math.max(Math.trunc(body.limit ?? 12), 1), SEARCH_LIMIT_MAX);
	const offset = Math.max(Math.trunc(body.offset ?? 0), 0);

	try {
		const ids = await relatedCorpusArticleIds(env, { id, type }, limit, offset);
		return jsonData({ ids }, INTERNAL_CORS_HEADERS);
	} catch (error) {
		console.error({ tag: 'SEARCH', msg: 'related search failed', error: error instanceof Error ? error.message : String(error) });
		return jsonError('SEARCH_FAILED', 'Related search failed', 500, INTERNAL_CORS_HEADERS);
	}
}

async function handleRetry(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { headers: INTERNAL_CORS_HEADERS });

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

	ctx.waitUntil(handleRetryCron(env, ctx));
	return jsonData({ queued: true }, INTERNAL_CORS_HEADERS);
}

async function handleWorkflowStream(request: Request, instanceId: string, env: Env): Promise<Response> {
	const unauth = await requireAuth(request, env);
	if (unauth) return unauth;

	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const encoder = new TextEncoder();
	const writeEvent = (data: object) => writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

	(async () => {
		try {
			for (let i = 0; i < 40; i++) {
				const instance = await env.MONITOR_WORKFLOW.get(instanceId);
				const { status, error, output } = await instance.status();
				const isTerminal = status === 'complete' || status === 'errored' || status === 'terminated';

				if (status === 'complete') {
					await writeEvent({ status: 'complete', output });
					return;
				}

				await writeEvent({ status, error });
				if (isTerminal) return;
				await sleep(3000);
			}
			await writeEvent({ status: 'timeout' });
		} catch (err) {
			await writeEvent({ status: 'error', error: String(err) });
		} finally {
			await writer.close();
		}
	})();

	return new Response(readable, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no',
		},
	});
}

function routePrefixGet(request: Request, pathname: string, env: Env): Response | Promise<Response> | null {
	if (pathname.startsWith('/stream/')) {
		const id = pathname.slice('/stream/'.length);
		if (id) return handleWorkflowStream(request, id, env);
	}
	const id = scrapeJobId(pathname);
	if (id) return handleScrapeJobStatus(request, id, env);
	return null;
}

// Match `/prefix/...` for any method; also match exact `/prefix` for OPTIONS
// so CORS preflights to the root URL still hit the handler.
function matchesEndpoint(pathname: string, method: string, ...prefixes: string[]): boolean {
	for (const p of prefixes) {
		if (pathname.startsWith(`${p}/`)) return true;
		if (method === 'OPTIONS' && pathname === p) return true;
	}
	return false;
}

export function routeRequest(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
	const { pathname } = new URL(request.url);
	const { method } = request;

	if (pathname === '/health') return health();
	if (matchesEndpoint(pathname, method, '/media/external')) {
		return handleProxy(request, env, ctx);
	}
	if (matchesEndpoint(pathname, method, '/media/asset')) {
		return handleR2Asset(request, env, ctx);
	}

	if (method === 'OPTIONS') {
		const handler = OPTIONS_ROUTES[pathname];
		if (handler) return handler(request, env, ctx);

		const id = scrapeJobId(pathname);
		if (id) return handleScrapeJobStatus(request, id, env);
	}

	if (method === 'POST') {
		const handler = POST_ROUTES[pathname];
		if (handler) return handler(request, env, ctx);
	}

	if (method === 'GET') {
		const response = routePrefixGet(request, pathname, env);
		if (response) return response;
	}

	return new Response(HELP_TEXT, { headers: { 'Content-Type': 'text/plain' } });
}
