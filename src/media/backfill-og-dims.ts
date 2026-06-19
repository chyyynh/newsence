import { requireAuth } from '@shared/auth/middleware';
import { ARTICLES_TABLE, createDbClient, type DbClient } from '@shared/db';
import { type PlatformMetadata, withOgDimensions } from '@shared/platform-metadata';
import type { Env } from '@shared/types';
import { measureImageDimensions } from './dimensions';

// On-demand backfill of OG image dimensions for articles that have an og image
// but no stored `ogImageWidth/Height` (the bulk of the corpus — most sources
// don't emit `og:image:width/height` meta tags, so dims only ever existed for a
// few like Techcrunch/OpenAI). Without dims the frontend hero/card start at a
// 16:9 placeholder and snap to the real ratio on load; measuring the bytes here
// (via the Images binding, same path as the workflow) fills them so the layout
// is correct on first paint.
//
// Server-to-server only (X-Internal-Token, same as /media/gc) — no schedule;
// run by hand when reclaiming historical rows. Re-runnable: keyset pagination by
// id means a `truncated: true` run resumes from `nextCursor`; rows that fail to
// measure stay null and are retried on a later run.

// Each measure is a full image fetch + one Images transform; cap a single
// invocation so it can't run unbounded and so the per-month Images bill from a
// backfill is predictable. 2000/run is proven to stay within the Worker request
// limits in practice. Re-run with `?cursor=<nextCursor>` to continue.
const MAX_PER_RUN = 2000;
const DB_PAGE = 100;
// Measure several images at once — each is mostly network wait. Modest so we
// don't hammer upstreams or open too many sockets at once.
const MEASURE_CONCURRENCY = 8;

interface CandidateRow {
	id: string;
	og_image_url: string;
	platform_metadata: PlatformMetadata | null;
}

type BackfillSummary = {
	scanned: number;
	updated: number;
	failed: number;
	truncated: boolean;
	nextCursor: string | null;
};

async function fetchCandidates(db: DbClient, cursor: string | null, limit: number): Promise<CandidateRow[]> {
	// Keyset pagination by id; only rows still missing dims. Updated rows drop out
	// of the predicate, but we page by id (not OFFSET) so failed-to-measure rows
	// don't stall the cursor within a single run.
	const result = await db.query(
		`SELECT id, og_image_url, platform_metadata
		   FROM ${ARTICLES_TABLE}
		  WHERE og_image_url IS NOT NULL AND og_image_url <> ''
		    AND (platform_metadata->>'ogImageWidth') IS NULL
		    AND ($1::uuid IS NULL OR id > $1::uuid)
		  ORDER BY id
		  LIMIT $2`,
		[cursor, limit],
	);
	return result.rows as CandidateRow[];
}

async function persistDims(db: DbClient, id: string, metadata: PlatformMetadata): Promise<void> {
	await db.query(`UPDATE ${ARTICLES_TABLE} SET platform_metadata = $1 WHERE id = $2`, [JSON.stringify(metadata), id]);
}

async function backfillRow(env: Env, db: DbClient, row: CandidateRow): Promise<'updated' | 'failed'> {
	const dims = await measureImageDimensions(env, row.og_image_url);
	if (!dims) return 'failed';
	await persistDims(db, row.id, withOgDimensions(row.platform_metadata, dims.width, dims.height));
	return 'updated';
}

async function runBackfill(env: Env, startCursor: string | null): Promise<BackfillSummary> {
	const db = await createDbClient(env);
	let scanned = 0;
	let updated = 0;
	let failed = 0;
	let cursor = startCursor;
	let truncated = false;

	try {
		while (scanned < MAX_PER_RUN) {
			const remaining = MAX_PER_RUN - scanned;
			const rows = await fetchCandidates(db, cursor, Math.min(DB_PAGE, remaining));
			if (rows.length === 0) break;

			for (let i = 0; i < rows.length; i += MEASURE_CONCURRENCY) {
				const batch = rows.slice(i, i + MEASURE_CONCURRENCY);
				const outcomes = await Promise.all(batch.map((row) => backfillRow(env, db, row)));
				for (const outcome of outcomes) {
					if (outcome === 'updated') updated++;
					else failed++;
				}
			}

			scanned += rows.length;
			cursor = rows[rows.length - 1].id;
			// A full page means there may be more; an underfull page exhausted the set.
			if (rows.length < Math.min(DB_PAGE, remaining)) break;
			if (scanned >= MAX_PER_RUN) truncated = true;
		}
	} finally {
		await db.end();
	}

	return { scanned, updated, failed, truncated, nextCursor: truncated ? cursor : null };
}

/**
 * POST /media/backfill-og-dims?cursor=<id>
 *
 * Measures + stores OG image dimensions for existing articles missing them.
 * `truncated: true` means the per-run cap was hit — re-run with the returned
 * `nextCursor` to continue. `failed` counts images that couldn't be measured
 * (404/timeout/SVG); they stay null and are retried on a future full sweep.
 */
export async function handleBackfillOgDims(request: Request, env: Env): Promise<Response> {
	const unauth = await requireAuth(request, env);
	if (unauth) return unauth;

	const cursor = new URL(request.url).searchParams.get('cursor');
	console.info({ tag: 'BACKFILL_OG_DIMS', msg: 'start', cursor: cursor ?? '(begin)' });

	let summary: BackfillSummary;
	try {
		summary = await runBackfill(env, cursor);
	} catch (err) {
		console.error({ tag: 'BACKFILL_OG_DIMS', msg: 'failed', error: String(err) });
		return Response.json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Backfill failed' } }, { status: 500 });
	}

	console.info({ tag: 'BACKFILL_OG_DIMS', msg: 'done', ...summary });
	return Response.json({ success: true, result: summary });
}
