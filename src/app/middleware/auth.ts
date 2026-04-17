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
