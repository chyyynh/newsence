import type { Env } from './types';

const ENCODER = new TextEncoder();

export const INTERNAL_CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, X-Internal-Token, Authorization',
};

async function timingSafeStringEqual(a: string, b: string): Promise<boolean> {
	const [hashA, hashB] = await Promise.all([
		crypto.subtle.digest('SHA-256', ENCODER.encode(a)),
		crypto.subtle.digest('SHA-256', ENCODER.encode(b)),
	]);
	return crypto.subtle.timingSafeEqual(hashA, hashB);
}

/**
 * Guard-style auth check: returns null when authorized, otherwise a pre-built
 * 401 Response. Callers do `const unauth = await requireAuth(req, env); if (unauth) return unauth;`.
 */
export async function requireAuth(request: Request, env: Env, extraHeaders?: HeadersInit): Promise<Response | null> {
	const expected = env.CORE_WORKER_INTERNAL_TOKEN?.trim();
	if (!expected) {
		// Fail closed: a missing server secret must never make the protected
		// surface (/ingest, /search, /media/*) world-writable. The token is
		// set in all deployed envs; an empty value is a misconfiguration, so we
		// reject and log loudly rather than silently opening the door.
		console.error({ tag: 'AUTH', msg: 'CORE_WORKER_INTERNAL_TOKEN is not set — rejecting internal-token request' });
		return Response.json({ code: 'UNAUTHORIZED', message: 'Missing or invalid internal token' }, { status: 401, headers: extraHeaders });
	}
	const provided = (
		request.headers.get('x-internal-token') ??
		request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
		''
	).trim();
	if (provided && (await timingSafeStringEqual(provided, expected))) return null;
	return Response.json({ code: 'UNAUTHORIZED', message: 'Missing or invalid internal token' }, { status: 401, headers: extraHeaders });
}

/**
 * Parse a JSON body, returning either the parsed value or a 400 Response.
 */
export async function parseJsonBody<T>(request: Request, extraHeaders?: HeadersInit): Promise<T | Response> {
	try {
		return (await request.json()) as T;
	} catch {
		return Response.json({ code: 'BAD_REQUEST', message: 'Invalid JSON body' }, { status: 400, headers: extraHeaders });
	}
}
