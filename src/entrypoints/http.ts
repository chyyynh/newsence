import { handleChat } from '@chat/handlers/chat';
import { handleEmbed } from '@ingest/handlers/embed';
import { handleIngest } from '@ingest/handlers/ingest';
import { handleWorkflowStream } from '@ingest/handlers/workflow-status';
import { handleGenerateImage } from '@media/generate-image';
import { handleProxy } from '@media/proxy';
import { handleR2Asset } from '@media/r2-asset';
import type { Env, ExecutionContext } from '@shared/types';
import { handleHealth } from './health';

type RouteHandler = (request: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;

const POST_ROUTES: Record<string, RouteHandler> = {
	'/api/chat': handleChat,
	'/embed': (req, env) => handleEmbed(req, env),
	'/generate-image': (req, env) => handleGenerateImage(req, env),
	'/ingest': (req, env) => handleIngest(req, env),
};

const HELP_TEXT =
	'Newsence Core Worker\n\n' +
	'HTTP endpoints (frontend):\n' +
	'GET  /health\n' +
	'POST /api/chat                            - AI chat (Phase 1 scaffold, mock stream; issue #136)\n' +
	'POST /ingest                              - Ingest URL (JSON), image URL (JSON), or user-uploaded blob (multipart)\n' +
	'POST /generate-image                      - AI image gen (OpenRouter → R2 → user_files)\n' +
	'POST /embed                               - Generate embeddings\n' +
	'GET  /stream/:instanceId                  - Workflow status (SSE)\n' +
	'\nSigned media:\n' +
	'GET  /media/external/{options}/{mediaUrl} - Upstream image/video passthrough with edge cache\n' +
	'GET  /media/asset/{key}?sig=&exp=         - Authenticated R2 asset\n';

function routePrefixGet(pathname: string, env: Env): Response | Promise<Response> | null {
	if (pathname.startsWith('/stream/')) {
		const id = pathname.slice('/stream/'.length);
		if (id) return handleWorkflowStream(id, env);
	}
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
	if (method === 'OPTIONS' && pathname === '/api/chat') return handleChat(request, env, ctx);

	if (method === 'POST') {
		const handler = POST_ROUTES[pathname];
		if (handler) return handler(request, env, ctx);
	}

	if (method === 'GET') {
		const response = routePrefixGet(pathname, env);
		if (response) return response;
	}

	return new Response(HELP_TEXT, { headers: { 'Content-Type': 'text/plain' } });
}
