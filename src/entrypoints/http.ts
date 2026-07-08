const ENCODER = new TextEncoder();

const WORKFLOW_STREAM_INTERVAL_MS = 3000;
const WORKFLOW_STREAM_ROUTE = new URLPattern({ pathname: '/stream/:instanceId' });
const TERMINAL_WORKFLOW_STATUSES = new Set(['complete', 'errored', 'error', 'terminated', 'timeout']);

type WorkflowStreamEvent = {
	error?: unknown;
	output?: unknown;
	status: string;
};

async function unauthorizedInternalRequest(request: Request, env: Env): Promise<Response | null> {
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
	return authorized ? null : Response.json({ code: 'UNAUTHORIZED', message: 'Missing or invalid internal token' }, { status: 401 });
}

const HELP_TEXT =
	'Newsence Core Worker\n\n' +
	'HTTP endpoints:\n' +
	'GET  /health\n' +
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

export async function routeRequest(request: Request, env: Env): Promise<Response> {
	const { pathname } = new URL(request.url);
	const { method } = request;
	const streamInstanceId = WORKFLOW_STREAM_ROUTE.exec({ pathname })?.pathname.groups.instanceId;

	if (pathname === '/health') {
		return Response.json({
			status: 'ok',
			worker: 'newsence-core',
			timestamp: new Date().toISOString(),
		});
	}

	if (method === 'GET' && streamInstanceId) {
		const unauthorized = await unauthorizedInternalRequest(request, env);
		if (unauthorized) return unauthorized;
		return handleWorkflowStream(request, streamInstanceId, env);
	}

	return new Response(HELP_TEXT, { headers: { 'Content-Type': 'text/plain' } });
}
