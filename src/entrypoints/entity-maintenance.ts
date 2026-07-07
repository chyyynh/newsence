// ─────────────────────────────────────────────────────────────
// Internal /entities/* maintenance endpoints (registered in http.ts).
// ─────────────────────────────────────────────────────────────

import { INTERNAL_CORS_HEADERS, parseJsonBody, requireAuth } from '@core-shared/auth';
import { type MaintenanceCursor, pruneOrphanEntities, repairMissingArticleEntityLinks } from '@entities/maintenance';
import { getEntityQualitySnapshot } from '@entities/quality-report';
import { Client } from 'pg';

export async function handleRepairEntityLinks(request: Request, env: Env): Promise<Response> {
	const unauth = await requireAuth(request, env, INTERNAL_CORS_HEADERS);
	if (unauth) return unauth;

	const body = await parseJsonBody<{
		limit?: number;
		before?: string;
		cursor?: unknown;
		includeLinked?: boolean;
		sourceType?: string;
	}>(request, INTERNAL_CORS_HEADERS);
	if (body instanceof Response) return body;

	const limitRaw = Number(body.limit);
	const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : 100, 1), 500);
	const before = body.before?.trim() || undefined;
	if (before && Number.isNaN(Date.parse(before))) {
		return Response.json({ code: 'BAD_REQUEST', message: 'Invalid before timestamp' }, { status: 400, headers: INTERNAL_CORS_HEADERS });
	}
	const cursorRecord =
		body.cursor && typeof body.cursor === 'object' && !Array.isArray(body.cursor) ? (body.cursor as Record<string, unknown>) : null;
	const publishedDate = typeof cursorRecord?.publishedDate === 'string' ? cursorRecord.publishedDate.trim() : '';
	const cursorId = typeof cursorRecord?.id === 'string' ? cursorRecord.id.trim() : '';
	const cursor: MaintenanceCursor | null =
		publishedDate && cursorId && !Number.isNaN(Date.parse(publishedDate)) ? { id: cursorId, publishedDate } : null;
	if (body.cursor !== undefined && !cursor) {
		return Response.json({ code: 'BAD_REQUEST', message: 'Invalid cursor' }, { status: 400, headers: INTERNAL_CORS_HEADERS });
	}
	const sourceType = typeof body.sourceType === 'string' && body.sourceType.trim() ? body.sourceType.trim() : null;
	if (body.sourceType !== undefined && !sourceType) {
		return Response.json({ code: 'BAD_REQUEST', message: 'Invalid sourceType' }, { status: 400, headers: INTERNAL_CORS_HEADERS });
	}
	const includeLinked = body.includeLinked === true;
	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	await db.query('BEGIN');
	try {
		const result = await repairMissingArticleEntityLinks(db, limit, {
			before,
			cursor: cursor ?? undefined,
			includeLinked,
			sourceType: sourceType ?? undefined,
		});
		await db.query('COMMIT');
		return Response.json({ ...result, includeLinked, sourceType: sourceType ?? null }, { headers: INTERNAL_CORS_HEADERS });
	} catch (error) {
		await db
			.query('ROLLBACK')
			.catch((rollbackError) => console.error({ tag: 'DB', msg: 'repair entity links rollback failed', error: String(rollbackError) }));
		throw error;
	}
}

export async function handleEntityQuality(request: Request, env: Env): Promise<Response> {
	const unauth = await requireAuth(request, env, INTERNAL_CORS_HEADERS);
	if (unauth) return unauth;

	const body = await parseJsonBody<{ months?: number }>(request, INTERNAL_CORS_HEADERS);
	if (body instanceof Response) return body;

	const monthsRaw = Number(body.months);
	const months = Math.min(Math.max(Number.isFinite(monthsRaw) ? Math.trunc(monthsRaw) : 6, 1), 24);
	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	const result = await getEntityQualitySnapshot(db, { months });
	return Response.json(result, { headers: INTERNAL_CORS_HEADERS });
}

export async function handlePruneOrphanEntities(request: Request, env: Env): Promise<Response> {
	const unauth = await requireAuth(request, env, INTERNAL_CORS_HEADERS);
	if (unauth) return unauth;

	const body = await parseJsonBody<{ limit?: number }>(request, INTERNAL_CORS_HEADERS);
	if (body instanceof Response) return body;

	const limitRaw = Number(body.limit);
	const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : 100, 1), 500);
	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	await db.query('BEGIN');
	try {
		const result = await pruneOrphanEntities(db, limit);
		await db.query('COMMIT');
		return Response.json(result, { headers: INTERNAL_CORS_HEADERS });
	} catch (error) {
		await db
			.query('ROLLBACK')
			.catch((rollbackError) => console.error({ tag: 'DB', msg: 'prune orphan entities rollback failed', error: String(rollbackError) }));
		throw error;
	}
}
