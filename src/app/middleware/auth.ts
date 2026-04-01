import { createDbClient } from '../../infra/db';
import { logWarn } from '../../infra/log';
import type { Env } from '../../models/types';

export function getInternalToken(request: Request): string | null {
	return request.headers.get('x-internal-token') ?? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
}

export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [hashA, hashB] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(a)),
		crypto.subtle.digest('SHA-256', encoder.encode(b)),
	]);
	return crypto.subtle.timingSafeEqual(hashA, hashB);
}

export async function isSubmitAuthorized(request: Request, env: Env): Promise<boolean> {
	const expected = env.CORE_WORKER_INTERNAL_TOKEN?.trim();
	if (!expected) return true; // Backward-compatible when token is not configured yet
	const provided = getInternalToken(request)?.trim();
	if (!provided) return false;
	return timingSafeEqual(provided, expected);
}

/** Validate that a user is a member of the given organization. Caller manages the db lifecycle. */
export async function checkOrgMembership(
	db: { query: (q: string, p: unknown[]) => Promise<{ rows: unknown[] }> },
	userId: string,
	organizationId: string,
): Promise<boolean> {
	const r = await db.query(`SELECT 1 FROM member WHERE "organizationId" = $1 AND "userId" = $2 LIMIT 1`, [organizationId, userId]);
	return r.rows.length > 0;
}

/** Standalone version — creates its own connection for entry-point validation. */
export async function validateOrgMembership(env: Env, userId: string, organizationId: string): Promise<boolean> {
	const db = await createDbClient(env);
	try {
		return await checkOrgMembership(db, userId, organizationId);
	} finally {
		await db.end();
	}
}

export async function isBotAuthorized(request: Request, env: Env): Promise<boolean> {
	const expected = env.CORE_WORKER_INTERNAL_TOKEN?.trim();
	if (!expected) {
		logWarn('TELEGRAM', 'CORE_WORKER_INTERNAL_TOKEN is not configured; denying request');
		return false;
	}
	const provided = getInternalToken(request)?.trim();
	if (!provided) return false;
	return timingSafeEqual(provided, expected);
}
