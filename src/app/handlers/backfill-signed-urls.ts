/**
 * One-shot backfill: rewrite legacy `og_image_url` rows to signed proxy URLs.
 *
 * Run repeatedly (or in a loop) until `processed: 0`:
 *   curl -H 'X-Internal-Token: $TOKEN' \
 *        '$WORKER/admin/backfill-signed-urls?table=articles&limit=500'
 *
 * Cursor-paginated (ORDER BY id, ?after=<lastId>) so non-http rows that
 * `signOgImageForStorage` skips don't block forward progress.
 */

import { ARTICLES_TABLE, createDbClient, USER_FILES_TABLE } from '../../infra/db';
import { getProxySigningConfig, signOgImageForStorage } from '../../lib/sign-url';
import type { Env } from '../../models/types';
import { requireAuth } from '../middleware/auth';

const TABLES = new Set<string>([ARTICLES_TABLE, USER_FILES_TABLE]);

export async function handleBackfillSignedUrls(request: Request, env: Env): Promise<Response> {
	const unauth = await requireAuth(request, env);
	if (unauth) return unauth;

	if (!getProxySigningConfig(env)) {
		return Response.json(
			{ success: false, error: { code: 'NOT_CONFIGURED', message: 'IMAGE_PROXY_SECRET / CORE_WORKER_PUBLIC_URL must be set' } },
			{ status: 503 },
		);
	}

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

		const signed = await Promise.all(rows.rows.map(async (row) => ({ row, signed: await signOgImageForStorage(env, row.og_image_url) })));
		const updates = signed.filter((r) => r.signed && r.signed !== r.row.og_image_url);

		if (updates.length > 0) {
			await db.query(
				`UPDATE ${table} AS t SET og_image_url = v.url
				 FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::text[]) AS url) v
				 WHERE t.id = v.id`,
				[updates.map((u) => u.row.id), updates.map((u) => u.signed)],
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
