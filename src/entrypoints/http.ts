import { handleIngest } from '@ingest/handlers/ingest';
import { handleScrape, handleScrapeJobCreate, handleScrapeJobStatus } from '@ingest/handlers/scrape';
import { handleBackfillOgDims } from '@media/backfill-og-dims';
import { handleDeleteAsset } from '@media/delete-asset';
import { handleOrphanGc } from '@media/orphan-gc';
import { handleProxy } from '@media/proxy';
import { handleR2Asset } from '@media/r2-asset';
import { parseJsonBody, requireAuth } from '@shared/auth/middleware';
import type { Env, ExecutionContext } from '@shared/types';
import { rankCorpusArticleIds, relatedCorpusArticleIds } from '../corpus';

type RouteHandler = (request: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;

const INTERNAL_CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, X-Internal-Token, Authorization',
};
const EMBED_CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
};
const EMBEDDING_MODEL = '@cf/baai/bge-m3';
const EMBED_MAX_TEXT = 8000;
const SEARCH_LIMIT_MAX = 500;

const POST_ROUTES: Record<string, RouteHandler> = {
	'/embed': (req, env) => handleEmbed(req, env),
	'/search': (req, env) => handleSearch(req, env),
	'/search/related': (req, env) => handleRelated(req, env),
	'/ingest': (req, env) => handleIngest(req, env),
	'/scrape': (req, env) => handleScrape(req, env),
	'/scrape/jobs': (req, env) => handleScrapeJobCreate(req, env),
	'/media/delete': (req, env) => handleDeleteAsset(req, env),
	'/media/gc': (req, env) => handleOrphanGc(req, env),
	'/media/backfill-og-dims': (req, env) => handleBackfillOgDims(req, env),
};

const HELP_TEXT =
	'Newsence Core Worker\n\n' +
	'HTTP endpoints (frontend):\n' +
	'GET  /health\n' +
	'POST /ingest                              - Ingest URL (JSON), image URL (JSON), or user-uploaded blob (multipart)\n' +
	'POST /scrape                              - Sync extraction: {url} JSON or raw bytes -> NormalizedContent {markdown,text,metadata,status}\n' +
	'POST /scrape/jobs                         - Async parse job (non-persisting): {url} or raw bytes -> {jobId}\n' +
	'GET  /scrape/jobs/:id                     - Poll parse job -> {status, result?, error?}\n' +
	'POST /embed                               - Generate embeddings\n' +
	'POST /search                              - Hybrid corpus ranking (internal token) -> {results:[{id,score}]}\n' +
	'POST /search/related                      - pgvector neighbours of a seed (internal token) -> {ids:[...]}\n' +
	'POST /media/delete                        - Batch-delete user-file R2 objects by storage key (#162)\n' +
	'POST /media/gc                            - On-demand reference-nowhere R2 orphan sweep (#162)\n' +
	'POST /media/backfill-og-dims?cursor=:id   - Measure + store OG image dims for articles missing them (re-run with nextCursor)\n' +
	'GET  /stream/:instanceId                  - Workflow status (SSE)\n' +
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

async function handleEmbed(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { headers: EMBED_CORS_HEADERS });

	const body = await parseJsonBody<{ text?: string; texts?: string[] }>(request, EMBED_CORS_HEADERS);
	if (body instanceof Response) return body;
	const input = body.texts || (body.text ? [body.text] : []);
	if (input.length === 0) {
		return Response.json({ error: 'No text provided' }, { status: 400, headers: EMBED_CORS_HEADERS });
	}

	const sanitized = input.map((t) => t.trim().slice(0, EMBED_MAX_TEXT));

	try {
		const result = (await env.AI.run(EMBEDDING_MODEL as Parameters<Ai['run']>[0], { text: sanitized })) as {
			data: number[][];
		};
		return Response.json(
			{ embeddings: result.data, model: EMBEDDING_MODEL, dimensions: 1024 },
			{ headers: { ...EMBED_CORS_HEADERS, 'Content-Type': 'application/json' } },
		);
	} catch (error) {
		console.error({ tag: 'EMBED', msg: 'Generation failed', error: String(error) });
		return Response.json(
			{ error: 'Embedding generation failed', details: error instanceof Error ? error.message : 'Unknown error' },
			{ status: 500, headers: EMBED_CORS_HEADERS },
		);
	}
}

async function handleSearch(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { headers: INTERNAL_CORS_HEADERS });

	const unauth = await requireAuth(request, env, INTERNAL_CORS_HEADERS);
	if (unauth) return unauth;

	const body = await parseJsonBody<{ query?: string; limit?: number }>(request, INTERNAL_CORS_HEADERS);
	if (body instanceof Response) return body;

	const query = body.query?.trim();
	if (!query) {
		return Response.json({ success: true, data: { results: [] } }, { headers: INTERNAL_CORS_HEADERS });
	}
	const limit = Math.min(Math.max(Math.trunc(body.limit ?? 100), 1), SEARCH_LIMIT_MAX);

	try {
		const results = await rankCorpusArticleIds(env, query, limit);
		return Response.json(
			{ success: true, data: { results } },
			{ headers: { ...INTERNAL_CORS_HEADERS, 'Content-Type': 'application/json' } },
		);
	} catch (error) {
		console.error({ tag: 'SEARCH', msg: 'hybrid search failed', error: error instanceof Error ? error.message : String(error) });
		return Response.json(
			{ success: false, error: { code: 'SEARCH_FAILED', message: 'Search failed' } },
			{ status: 500, headers: INTERNAL_CORS_HEADERS },
		);
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
		return Response.json(
			{ success: false, error: { code: 'BAD_REQUEST', message: 'Missing seed id' } },
			{ status: 400, headers: INTERNAL_CORS_HEADERS },
		);
	}
	const limit = Math.min(Math.max(Math.trunc(body.limit ?? 12), 1), SEARCH_LIMIT_MAX);
	const offset = Math.max(Math.trunc(body.offset ?? 0), 0);

	try {
		const ids = await relatedCorpusArticleIds(env, { id, type }, limit, offset);
		return Response.json({ success: true, data: { ids } }, { headers: { ...INTERNAL_CORS_HEADERS, 'Content-Type': 'application/json' } });
	} catch (error) {
		console.error({ tag: 'SEARCH', msg: 'related search failed', error: error instanceof Error ? error.message : String(error) });
		return Response.json(
			{ success: false, error: { code: 'SEARCH_FAILED', message: 'Related search failed' } },
			{ status: 500, headers: INTERNAL_CORS_HEADERS },
		);
	}
}

function handleWorkflowStream(instanceId: string, env: Env): Response {
	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const encoder = new TextEncoder();
	const writeEvent = (data: object) => writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

	(async () => {
		try {
			for (let i = 0; i < 40; i++) {
				await new Promise((r) => setTimeout(r, 3000));

				const instance = await env.MONITOR_WORKFLOW.get(instanceId);
				const { status, error } = await instance.status();
				const isTerminal = status === 'complete' || status === 'errored' || status === 'terminated';

				if (status === 'complete') {
					await writeEvent({ status: 'complete' });
					return;
				}

				await writeEvent({ status, error });
				if (isTerminal) return;
			}
		} catch (err) {
			await writeEvent({ status: 'error', error: String(err) });
		} finally {
			await writer.close();
		}
	})();

	return new Response(readable, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		},
	});
}

function routePrefixGet(request: Request, pathname: string, env: Env): Response | Promise<Response> | null {
	if (pathname.startsWith('/stream/')) {
		const id = pathname.slice('/stream/'.length);
		if (id) return handleWorkflowStream(id, env);
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

	if (method === 'OPTIONS' && pathname === '/embed') return handleEmbed(request, env);
	if (method === 'OPTIONS' && pathname === '/search') return handleSearch(request, env);
	if (method === 'OPTIONS' && pathname === '/search/related') return handleRelated(request, env);
	if (method === 'OPTIONS' && pathname === '/scrape') return handleScrape(request, env);
	if (method === 'OPTIONS' && pathname === '/scrape/jobs') return handleScrapeJobCreate(request, env);
	if (method === 'OPTIONS') {
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
