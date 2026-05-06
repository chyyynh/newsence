/**
 * One-shot backfill: rewrite legacy signed `og_image_url` rows back to raw
 * upstream URLs. After this PR the worker no longer signs at storage time —
 * the frontend signs at the API boundary instead — so existing rows that
 * were stored signed (`/proxy/passthrough/{encodedUrl}?sig=&exp=`) need to be
 * unwrapped to their original upstream URL. The frontend will sign them on
 * each response, so secret rotation no longer requires a DB backfill.
 *
 * Run repeatedly (or in a loop) until `processed: 0`:
 *   curl -H 'X-Internal-Token: $TOKEN' \
 *        '$WORKER/admin/backfill-signed-urls?table=articles&limit=500'
 *
 * Cursor-paginated (ORDER BY id, ?after=<lastId>). Idempotent — rows that are
 * already raw (or non-http) are counted as scanned but not updated.
 */

import { ARTICLES_TABLE, createDbClient, USER_FILES_TABLE } from '../../infra/db';
import type { Env } from '../../models/types';
import { requireAuth } from '../middleware/auth';

const TABLES = new Set<string>([ARTICLES_TABLE, USER_FILES_TABLE]);

// Match `<origin>/proxy/passthrough/<encodedUrl>?…`. The origin is allowed to
// be any host because we may have rotated CORE_WORKER_PUBLIC_URL over time and
// old rows could carry either value; we only need the encoded upstream segment.
const SIGNED_URL_RE = /^https?:\/\/[^/]+\/proxy\/passthrough\/([^?/]+)\?/;

function unwrapSignedUrl(url: string | null): string | null {
	if (!url) return null;
	const m = url.match(SIGNED_URL_RE);
	if (!m) return null;
	try {
		const decoded = decodeURIComponent(m[1]);
		return /^https?:\/\//i.test(decoded) ? decoded : null;
	} catch {
		return null;
	}
}

export async function handleBackfillSignedUrls(request: Request, env: Env): Promise<Response> {
	const unauth = await requireAuth(request, env);
	if (unauth) return unauth;

	const url = new URL(request.url);
	const table = url.searchParams.get('table') ?? ARTICLES_TABLE;
	const limit = Math.min(Number.parseInt(url.searchParams.get('limit') ?? '500', 10) || 500, 2000);
	const after = url.searchParams.get('after') ?? '00000000-0000-0000-0000-000000000000';
	if (!TABLES.has(table)) {
		return Response.json({ success: false, error: { code: 'BAD_REQUEST', message: `Unknown table: ${table}` } }, { status: 400 });
	}

	const db = await createDbClient(env);
	try {
		const rows = await db.query<{ id: string; og_image_url: string }>(
			`SELECT id, og_image_url FROM ${table}
			 WHERE og_image_url IS NOT NULL AND id > $1::uuid
			 ORDER BY id ASC
			 LIMIT $2`,
			[after, limit],
		);

		const updates = rows.rows
			.map((row) => ({ row, raw: unwrapSignedUrl(row.og_image_url) }))
			.filter((r): r is { row: { id: string; og_image_url: string }; raw: string } => r.raw !== null);

		if (updates.length > 0) {
			await db.query(
				`UPDATE ${table} AS t SET og_image_url = v.url
				 FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::text[]) AS url) v
				 WHERE t.id = v.id`,
				[updates.map((u) => u.row.id), updates.map((u) => u.raw)],
			);
		}

		const nextCursor = rows.rows.length > 0 ? rows.rows[rows.rows.length - 1].id : null;
		return Response.json({
			success: true,
			table,
			scanned: rows.rows.length,
			processed: updates.length,
			skipped: rows.rows.length - updates.length,
			nextCursor,
		});
	} finally {
		await db.end();
	}
}
