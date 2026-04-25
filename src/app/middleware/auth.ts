import type { Env } from '../../models/types';

function getInternalToken(request: Request): string | null {
	return request.headers.get('x-internal-token') ?? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
}

export async function isSubmitAuthorized(request: Request, env: Env): Promise<boolean> {
	const expected = env.CORE_WORKER_INTERNAL_TOKEN?.trim();
	if (!expected) return true;
	const provided = getInternalToken(request)?.trim();
	if (!provided) return false;
	return provided === expected;
}

/**
 * Guard-style auth check: returns null when authorized, otherwise a pre-built
 * 401 Response. Callers do `const unauth = await requireAuth(req, env); if (unauth) return unauth;`.
 */
export async function requireAuth(request: Request, env: Env, extraHeaders?: HeadersInit): Promise<Response | null> {
	if (await isSubmitAuthorized(request, env)) return null;
	return Response.json(
		{ success: false, error: { code: 'UNAUTHORIZED', message: 'Missing or invalid internal token' } },
		{ status: 401, headers: extraHeaders },
	);
}

/**
 * Parse a JSON body, returning either the parsed value or a 400 Response.
 * The error envelope matches the rest of the worker's error shape.
 */
export async function parseJsonBody<T>(request: Request, extraHeaders?: HeadersInit): Promise<T | Response> {
	try {
		return (await request.json()) as T;
	} catch {
		return Response.json(
			{ success: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
			{ status: 400, headers: extraHeaders },
		);
	}
}
