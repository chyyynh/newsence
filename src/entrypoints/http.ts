import { handleEmbed } from '../app/handlers/embed';
import { handleEnqueueUserFile } from '../app/handlers/enqueue-user-file';
import { handleHealth, handleTestScrape } from '../app/handlers/health';
import { handlePreview } from '../app/handlers/preview';
import { handleProxy } from '../app/handlers/proxy';
import { handleRehostImage } from '../app/handlers/rehost-image';
import { handleSubmitUrl } from '../app/handlers/submit';
import { handleWorkflowStatus, handleWorkflowStream } from '../app/handlers/workflow-status';
import type { Env } from '../models/types';

type RouteHandler = (request: Request, env: Env) => Response | Promise<Response>;

const POST_ROUTES: Record<string, RouteHandler> = {
	'/embed': handleEmbed,
	'/submit': handleSubmitUrl,
	'/enqueue-user-file': handleEnqueueUserFile,
	'/rehost-image': handleRehostImage,
};

const HELP_TEXT =
	'Newsence Core Worker\n\n' +
	'HTTP endpoints (frontend):\n' +
	'GET  /health\n' +
	'*    /preview                    - Scrape-only\n' +
	'POST /submit                     - Submit URL\n' +
	'POST /embed                      - Generate embeddings\n' +
	'POST /enqueue-user-file          - Kick off workflow for an uploaded user_file (PDF)\n' +
	'POST /rehost-image               - Fetch user-supplied image URL → R2 (SSRF-safe)\n' +
	'GET  /status/:instanceId         - Workflow status (JSON)\n' +
	'GET  /stream/:instanceId         - Workflow status (SSE)\n' +
	'\nPublic media proxy:\n' +
	'GET  /proxy/{options}/{mediaUrl} - Image/video passthrough with edge cache\n';

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

export function routeRequest(request: Request, env: Env): Response | Promise<Response> {
	const { pathname } = new URL(request.url);

	if (pathname === '/health') return handleHealth(env);
	if (pathname === '/preview') return handlePreview(request, env);
	if (pathname === '/scrape') return handleTestScrape(request, env);
	if (pathname.startsWith('/proxy/') || (request.method === 'OPTIONS' && pathname.startsWith('/proxy'))) {
		return handleProxy(request, env);
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
