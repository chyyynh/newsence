// ─────────────────────────────────────────────────────────────
// Internal /entities/* maintenance endpoints (registered in http.ts).
// ─────────────────────────────────────────────────────────────

import { INTERNAL_CORS_HEADERS, parseJsonBody, requireAuth } from '@core-shared/auth';
import { type MaintenanceCursor, pruneOrphanEntities, repairMissingArticleEntityLinks } from '@entities/maintenance';
import { getEntityQualitySnapshot } from '@entities/quality-report';
import { Client } from 'pg';

function boundedMaintenanceLimit(value: unknown, fallback = 100, max = 500): number {
	return Math.min(Math.max(Number.isFinite(value) ? Math.trunc(Number(value)) : fallback, 1), max);
}

function parseMaintenanceCursor(value: unknown): MaintenanceCursor | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const publishedDate = typeof record.publishedDate === 'string' ? record.publishedDate.trim() : '';
	const id = typeof record.id === 'string' ? record.id.trim() : '';
	if (!publishedDate || !id || Number.isNaN(Date.parse(publishedDate))) return null;
	return { id, publishedDate };
}

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

	const limit = boundedMaintenanceLimit(body.limit);
	const before = body.before?.trim() || undefined;
	if (before && Number.isNaN(Date.parse(before))) {
		return Response.json({ code: 'BAD_REQUEST', message: 'Invalid before timestamp' }, { status: 400, headers: INTERNAL_CORS_HEADERS });
	}
	const cursor = parseMaintenanceCursor(body.cursor);
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

	const months = boundedMaintenanceLimit(body.months, 6, 24);
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

	const limit = boundedMaintenanceLimit(body.limit);
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
