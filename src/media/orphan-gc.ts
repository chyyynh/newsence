import { requireAuth } from '@shared/auth/middleware';
import { createDbClient, type DbClient, USER_FILES_TABLE } from '@shared/db';
import type { Env } from '@shared/types';

// All user-file blobs live under this prefix (ingest + chat-generated images).
const GC_PREFIX = 'users/';

// Steady state produces no orphans — the delete path is blob-first, so a failed
// blob delete aborts before the row is removed (visible, retryable) instead of
// leaking. This endpoint is the one-time/occasional reaper for historical
// orphans left by the old row-first design. The grace window still guards the
// R2-before-DB write ordering of ingest, so a manual run can't race an upload.
const GRACE_MS = 24 * 60 * 60 * 1000;

const R2_LIST_PAGE = 1000;
const R2_DELETE_BATCH = 1000; // R2 batch delete hard cap
const DB_LOOKUP_BATCH = 500; // keep the ANY($1) parameter array modest

// Bound a single invocation so it can't sweep an unbounded bucket; the remainder
// is reported (never silently dropped) and picked up by re-running.
const MAX_CANDIDATES_PER_RUN = 20_000;

type GcSummary = { candidates: number; deleted: number; truncated: boolean };

async function findExistingKeys(db: DbClient, keys: string[]): Promise<Set<string>> {
	const found = new Set<string>();
	for (let i = 0; i < keys.length; i += DB_LOOKUP_BATCH) {
		const batch = keys.slice(i, i + DB_LOOKUP_BATCH);
		const result = await db.query(`SELECT storage_key FROM ${USER_FILES_TABLE} WHERE storage_key = ANY($1)`, [batch]);
		for (const row of result.rows as { storage_key: string }[]) found.add(row.storage_key);
	}
	return found;
}

async function sweepOrphans(env: Env): Promise<GcSummary> {
	const db = await createDbClient(env);
	let candidates = 0;
	let deleted = 0;
	let truncated = false;

	try {
		const cutoff = Date.now() - GRACE_MS;
		const pending: string[] = [];

		// Resolve which pending keys are orphans (no row) and delete them.
		const flush = async () => {
			if (pending.length === 0) return;
			const present = await findExistingKeys(db, pending);
			const orphans = pending.filter((key) => !present.has(key));
			for (let i = 0; i < orphans.length; i += R2_DELETE_BATCH) {
				await env.R2.delete(orphans.slice(i, i + R2_DELETE_BATCH));
			}
			deleted += orphans.length;
			pending.length = 0;
		};

		let cursor: string | undefined;
		do {
			const listing = await env.R2.list({ prefix: GC_PREFIX, cursor, limit: R2_LIST_PAGE });
			for (const obj of listing.objects) {
				if (obj.uploaded.getTime() >= cutoff) continue; // within grace — skip
				pending.push(obj.key);
				candidates += 1;
			}
			cursor = listing.truncated ? listing.cursor : undefined;

			if (pending.length >= R2_DELETE_BATCH) await flush();
			if (candidates >= MAX_CANDIDATES_PER_RUN) {
				truncated = Boolean(cursor);
				break;
			}
		} while (cursor);

		await flush();
	} finally {
		await db.end();
	}

	return { candidates, deleted, truncated };
}

/**
 * On-demand reference-nowhere R2 GC (#162). Server-to-server only
 * (X-Internal-Token, same as /ingest, /media/delete) — there is no schedule;
 * run it by hand when reclaiming historical orphans.
 *
 * Safe by construction: only deletes objects under `users/` with NO matching
 * `user_files` row, so a file still in a library OR embedded in a document
 * (both keep a row) can never be collected — no citation/content scan needed.
 * `truncated: true` means the per-run cap was hit; re-run to continue.
 */
export async function handleOrphanGc(request: Request, env: Env): Promise<Response> {
	const unauth = await requireAuth(request, env);
	if (unauth) return unauth;

	console.info({ tag: 'ORPHAN_GC', msg: 'start' });
	let summary: GcSummary;
	try {
		summary = await sweepOrphans(env);
	} catch (err) {
		console.error({ tag: 'ORPHAN_GC', msg: 'failed', error: String(err) });
		return Response.json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'GC sweep failed' } }, { status: 500 });
	}

	console.info({ tag: 'ORPHAN_GC', msg: 'done', ...summary });
	return Response.json({ success: true, result: summary });
}
