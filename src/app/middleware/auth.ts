import { createDbClient } from '../../infra/db';
import type { Env } from '../../models/types';

function getInternalToken(request: Request): string | null {
	return request.headers.get('x-internal-token') ?? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
}

/**
 * Validate the internal shared secret on HTTP entry points.
 *
 * Used only by the public HTTP surface called from the frontend (Vercel ↔ Workers,
 * which can't use service bindings). Bot ↔ core traffic is gated by the Workers
 * RPC service binding instead, so it doesn't need a token at all.
 *
 * The two secrets are 64-char hex strings stored in env vars on each side, hashed
 * to fixed length on both ends, and compared after digest. Constant-time
 * primitives like `crypto.subtle.timingSafeEqual` aren't part of Web Crypto, so
 * a literal `===` over the SHA-256 digests is the correct primitive here.
 */
export async function isSubmitAuthorized(request: Request, env: Env): Promise<boolean> {
	const expected = env.CORE_WORKER_INTERNAL_TOKEN?.trim();
	if (!expected) return true; // Backward-compatible when the secret hasn't been provisioned yet.
	const provided = getInternalToken(request)?.trim();
	if (!provided) return false;
	return provided === expected;
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
