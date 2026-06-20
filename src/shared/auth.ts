import type { Env } from './types';

export function jsonData<T>(data: T, headers?: HeadersInit): Response {
	return Response.json({ success: true, data }, { headers });
}

export function jsonError(code: string, message: string, status: number, headers?: HeadersInit): Response {
	return Response.json({ success: false, error: { code, message } }, { status, headers });
}

function getInternalToken(request: Request): string | null {
	return request.headers.get('x-internal-token') ?? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
}

async function timingSafeStringEqual(a: string, b: string): Promise<boolean> {
	const enc = new TextEncoder();
	const [hashA, hashB] = await Promise.all([
		crypto.subtle.digest('SHA-256', enc.encode(a)),
		crypto.subtle.digest('SHA-256', enc.encode(b)),
	]);
	return crypto.subtle.timingSafeEqual(hashA, hashB);
}

export async function isInternalRequestAuthorized(request: Request, env: Env): Promise<boolean> {
	const expected = env.CORE_WORKER_INTERNAL_TOKEN?.trim();
	if (!expected) {
		// Fail closed: a missing server secret must never make the protected
		// surface (/ingest, /search, /media/*) world-writable. The token is
		// set in all deployed envs; an empty value is a misconfiguration, so we
		// reject and log loudly rather than silently opening the door.
		console.error({ tag: 'AUTH', msg: 'CORE_WORKER_INTERNAL_TOKEN is not set — rejecting internal-token request' });
		return false;
	}
	const provided = getInternalToken(request)?.trim();
	if (!provided) return false;
	return timingSafeStringEqual(provided, expected);
}

/**
 * Guard-style auth check: returns null when authorized, otherwise a pre-built
 * 401 Response. Callers do `const unauth = await requireAuth(req, env); if (unauth) return unauth;`.
 */
export async function requireAuth(request: Request, env: Env, extraHeaders?: HeadersInit): Promise<Response | null> {
	if (await isInternalRequestAuthorized(request, env)) return null;
	return jsonError('UNAUTHORIZED', 'Missing or invalid internal token', 401, extraHeaders);
}

/**
 * Parse a JSON body, returning either the parsed value or a 400 Response.
 * The error envelope matches the rest of the worker's error shape.
 */
export async function parseJsonBody<T>(request: Request, extraHeaders?: HeadersInit): Promise<T | Response> {
	try {
		return (await request.json()) as T;
	} catch {
		return jsonError('BAD_REQUEST', 'Invalid JSON body', 400, extraHeaders);
	}
}
