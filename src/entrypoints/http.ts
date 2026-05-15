import { handleEmbed } from '../app/handlers/embed';
import { handleHealth } from '../app/handlers/health';
import { handleIngest } from '../app/handlers/ingest';
import { handleProxy } from '../app/handlers/proxy';
import { handleR2Asset } from '../app/handlers/r2-asset';
import { handleRehostImage } from '../app/handlers/rehost-image';
import { handleWorkflowStream } from '../app/handlers/workflow-status';
import type { Env, ExecutionContext } from '../models/types';

type RouteHandler = (request: Request, env: Env) => Response | Promise<Response>;

const POST_ROUTES: Record<string, RouteHandler> = {
	'/embed': handleEmbed,
	'/ingest': handleIngest,
	'/rehost-image': handleRehostImage,
};

const HELP_TEXT =
	'Newsence Core Worker\n\n' +
	'HTTP endpoints (frontend):\n' +
	'GET  /health\n' +
	'POST /ingest                              - Ingest URL (JSON) or blob (multipart)\n' +
	'POST /embed                               - Generate embeddings\n' +
	'POST /rehost-image                        - Fetch user-supplied image URL → R2 (SSRF-safe)\n' +
	'GET  /stream/:instanceId                  - Workflow status (SSE)\n' +
	'\nSigned media:\n' +
	'GET  /media/external/{options}/{mediaUrl} - Upstream image/video passthrough with edge cache (was /proxy/)\n' +
	'GET  /media/asset/{key}?sig=&exp=         - Authenticated R2 asset (was /r2/)\n' +
	'\nLegacy aliases (grace window, slated for removal in follow-up):\n' +
	'GET  /proxy/...                           - alias of /media/external/\n' +
	'GET  /r2/...                              - alias of /media/asset/\n';

function routePrefixGet(pathname: string, env: Env): Response | Promise<Response> | null {
	if (pathname.startsWith('/stream/')) {
		const id = pathname.slice('/stream/'.length);
		if (id) return handleWorkflowStream(id, env);
	}
	return null;
}

function routeRootOrChild(pathname: string, root: string): boolean {
	return pathname === root || pathname.startsWith(`${root}/`);
}

export function routeRequest(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
	const { pathname } = new URL(request.url);

	if (pathname === '/health') return handleHealth(env);
	// `/proxy/` is a grace-window alias of `/media/external/`. Removed in a
	// follow-up once cached HTML signed under the old path has expired
	// (15-min sig quantize for /r2, 24h for /proxy — see frontend signers).
	if (
		pathname.startsWith('/media/external/') ||
		pathname.startsWith('/proxy/') ||
		(request.method === 'OPTIONS' && (routeRootOrChild(pathname, '/media/external') || routeRootOrChild(pathname, '/proxy')))
	) {
		return handleProxy(request, env, ctx);
	}
	if (
		pathname.startsWith('/media/asset/') ||
		pathname.startsWith('/r2/') ||
		(request.method === 'OPTIONS' && (routeRootOrChild(pathname, '/media/asset') || routeRootOrChild(pathname, '/r2')))
	) {
		return handleR2Asset(request, env, ctx);
	}

	if (request.method === 'OPTIONS' && pathname === '/embed') return handleEmbed(request, env);

	if (request.method === 'POST') {
		const handler = POST_ROUTES[pathname];
		if (handler) return handler(request, env);
	}

	if (request.method === 'GET') {
		const response = routePrefixGet(pathname, env);
		if (response) return response;
	}

	return new Response(HELP_TEXT, { headers: { 'Content-Type': 'text/plain' } });
}
