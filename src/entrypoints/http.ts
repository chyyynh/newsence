import { handleEmbed } from '@ingest/handlers/embed';
import { handleIngest } from '@ingest/handlers/ingest';
import { handleScrape, handleScrapeJobCreate, handleScrapeJobStatus } from '@ingest/handlers/scrape';
import { handleWorkflowStream } from '@ingest/handlers/workflow-status';
import { handleDeleteAsset } from '@media/delete-asset';
import { handleGenerateImage } from '@media/generate-image';
import { handleOrphanGc } from '@media/orphan-gc';
import { handleProxy } from '@media/proxy';
import { handleR2Asset } from '@media/r2-asset';
import type { Env, ExecutionContext } from '@shared/types';
import { handleHealth } from './health';

type RouteHandler = (request: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;

const POST_ROUTES: Record<string, RouteHandler> = {
	'/embed': (req, env) => handleEmbed(req, env),
	'/generate-image': (req, env) => handleGenerateImage(req, env),
	'/ingest': (req, env) => handleIngest(req, env),
	'/scrape': (req, env) => handleScrape(req, env),
	'/scrape/jobs': (req, env) => handleScrapeJobCreate(req, env),
	'/media/delete': (req, env) => handleDeleteAsset(req, env),
	'/media/gc': (req, env) => handleOrphanGc(req, env),
};

const HELP_TEXT =
	'Newsence Core Worker\n\n' +
	'HTTP endpoints (frontend):\n' +
	'GET  /health\n' +
	'POST /ingest                              - Ingest URL (JSON), image URL (JSON), or user-uploaded blob (multipart)\n' +
	'POST /scrape                              - Sync extraction: {url} JSON or raw bytes -> NormalizedContent {markdown,text,metadata,status}\n' +
	'POST /scrape/jobs                         - Async parse job (non-persisting): {url} or raw bytes -> {jobId}\n' +
	'GET  /scrape/jobs/:id                     - Poll parse job -> {status, result?, error?}\n' +
	'POST /generate-image                      - AI image gen (OpenRouter → R2 → user_files)\n' +
	'POST /embed                               - Generate embeddings\n' +
	'POST /media/delete                        - Batch-delete user-file R2 objects by storage key (#162)\n' +
	'POST /media/gc                            - On-demand reference-nowhere R2 orphan sweep (#162)\n' +
	'GET  /stream/:instanceId                  - Workflow status (SSE)\n' +
	'\nSigned media:\n' +
	'GET  /media/external/{options}/{mediaUrl} - Upstream image/video passthrough with edge cache\n' +
	'GET  /media/asset/{key}?sig=&exp=         - Authenticated R2 asset\n';

function scrapeJobId(pathname: string): string | null {
	if (!pathname.startsWith('/scrape/jobs/')) return null;
	return pathname.slice('/scrape/jobs/'.length) || null;
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

	if (pathname === '/health') return handleHealth(env);
	if (matchesEndpoint(pathname, method, '/media/external')) {
		return handleProxy(request, env, ctx);
	}
	if (matchesEndpoint(pathname, method, '/media/asset')) {
		return handleR2Asset(request, env, ctx);
	}

	if (method === 'OPTIONS' && pathname === '/embed') return handleEmbed(request, env);
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
