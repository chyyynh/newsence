import { handleScrape, handleScrapeJobCreate, handleScrapeJobStatus } from '@ingest/handlers/scrape';
import { handleExportCollectionOkf } from '../okf';

type RouteHandler = (request: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;

const ENCODER = new TextEncoder();
const INTERNAL_CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, X-Internal-Token, Authorization',
};
const SCRAPE_CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, X-Internal-Token, Authorization',
};
const OKF_EXPORT_CORS = { ...INTERNAL_CORS_HEADERS, 'Access-Control-Expose-Headers': 'Content-Disposition' };

const POST_ROUTES: Record<string, RouteHandler> = {
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

function routeAuthHeaders(pathname: string): HeadersInit | undefined {
	if (pathname === '/scrape' || pathname.startsWith('/scrape/jobs')) return SCRAPE_CORS_HEADERS;
	if (pathname === '/okf/collections/export') return OKF_EXPORT_CORS;
	if (POST_ROUTES[pathname]) return INTERNAL_CORS_HEADERS;
	return undefined;
}

async function unauthorizedInternalRequest(request: Request, env: Env, pathname: string): Promise<Response | null> {
	const expected = env.CORE_WORKER_INTERNAL_TOKEN?.trim();
	const provided = (
		request.headers.get('x-internal-token') ??
		request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
		''
	).trim();
	let authorized = false;
	if (!expected) {
		console.error({ tag: 'AUTH', msg: 'CORE_WORKER_INTERNAL_TOKEN is not set — rejecting internal-token request' });
	} else if (provided) {
		const [providedHash, expectedHash] = await Promise.all([
			crypto.subtle.digest('SHA-256', ENCODER.encode(provided)),
			crypto.subtle.digest('SHA-256', ENCODER.encode(expected)),
		]);
		authorized = crypto.subtle.timingSafeEqual(providedHash, expectedHash);
	}
	return authorized
		? null
		: Response.json(
				{ code: 'UNAUTHORIZED', message: 'Missing or invalid internal token' },
				{ status: 401, headers: routeAuthHeaders(pathname) },
			);
}

const HELP_TEXT =
	'Newsence Core Worker\n\n' +
	'HTTP endpoints:\n' +
	'GET  /health\n' +
	'POST /okf/collections/export              - Export a collection as an OKF v0.1 bundle tar.gz (internal token) -> gzip stream\n' +
	'POST /scrape                              - Sync extraction: {url} JSON or raw bytes -> NormalizedContent {markdown,text,metadata,status}\n' +
	'POST /scrape/jobs                         - Async parse job (non-persisting): {url} or raw bytes -> {jobId}\n' +
	'GET  /scrape/jobs/:id                     - Poll parse job -> {status, result?, error?}\n' +
	'GET  /stream/:instanceId                  - Workflow status (SSE, internal token)\n';

async function handleWorkflowStream(request: Request, instanceId: string, env: Env): Promise<Response> {
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

export async function routeRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const { pathname } = new URL(request.url);
	const { method } = request;
	const scrapeJobId = SCRAPE_JOB_ROUTE.exec({ pathname })?.pathname.groups.jobId;
	const streamInstanceId = WORKFLOW_STREAM_ROUTE.exec({ pathname })?.pathname.groups.instanceId;

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

		if (scrapeJobId) return handleScrapeJobStatus(request, scrapeJobId, env);
	}

	const needsAuth = (method === 'POST' && !!POST_ROUTES[pathname]) || (method === 'GET' && (!!streamInstanceId || !!scrapeJobId));
	if (needsAuth) {
		const unauthorized = await unauthorizedInternalRequest(request, env, pathname);
		if (unauthorized) return unauthorized;
	}

	if (method === 'POST') {
		const handler = POST_ROUTES[pathname];
		if (handler) return handler(request, env, ctx);
	}

	if (method === 'GET') {
		if (streamInstanceId) return handleWorkflowStream(request, streamInstanceId, env);

		if (scrapeJobId) return handleScrapeJobStatus(request, scrapeJobId, env);
	}

	return new Response(HELP_TEXT, { headers: { 'Content-Type': 'text/plain' } });
}
