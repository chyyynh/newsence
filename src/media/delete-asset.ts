import { parseJsonBody, requireAuth } from '@shared/auth/middleware';
import { logError } from '@shared/log';
import type { Env } from '@shared/types';

type DeleteAssetBody = { storageKeys?: unknown };

// Only user-namespaced uploads may be deleted through this endpoint. Even with a
// valid internal token, a buggy (or compromised) caller must never be able to
// wipe article media, the proxy cache, or any other R2 namespace — so keys are
// filtered to the `users/` prefix that ingest/generate-image write under.
const DELETABLE_PREFIX = 'users/';

// R2 batch delete caps at 1000 keys per call. This endpoint is reused
// server-to-server, so chunk defensively rather than trusting every caller to
// stay under the limit — an oversized array would otherwise throw mid-delete.
const R2_BATCH_LIMIT = 1000;

/**
 * Batch-delete R2 user-file objects by storage key. Server-to-server only
 * (X-Internal-Token, same as /ingest) — the frontend owns ownership/citation
 * checks before calling here; this endpoint is the dumb R2 hand (#162).
 *
 * Idempotent: R2 delete is a no-op for missing keys, so a retry after a partial
 * failure is safe.
 */
export async function handleDeleteAsset(request: Request, env: Env): Promise<Response> {
	const unauth = await requireAuth(request, env);
	if (unauth) return unauth;

	const body = await parseJsonBody<DeleteAssetBody>(request);
	if (body instanceof Response) return body;

	const requested = Array.isArray(body.storageKeys) ? body.storageKeys : [];
	const keys = requested.filter((k): k is string => typeof k === 'string' && k.startsWith(DELETABLE_PREFIX));
	const rejected = requested.length - keys.length;

	if (keys.length === 0) {
		return Response.json({ success: true, result: { deleted: 0, rejected } });
	}

	try {
		for (let i = 0; i < keys.length; i += R2_BATCH_LIMIT) {
			await env.R2.delete(keys.slice(i, i + R2_BATCH_LIMIT));
		}
	} catch (err) {
		logError('MEDIA_DELETE', 'R2 batch delete failed', { count: keys.length, error: String(err) });
		return Response.json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'R2 delete failed' } }, { status: 500 });
	}

	return Response.json({ success: true, result: { deleted: keys.length, rejected } });
}
