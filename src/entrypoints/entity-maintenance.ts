// ─────────────────────────────────────────────────────────────
// Internal /entities/* maintenance endpoints (registered in http.ts).
// ─────────────────────────────────────────────────────────────

import { INTERNAL_CORS_HEADERS, jsonData, jsonError, parseJsonBody, requireAuth } from '@core-shared/auth';
import { withDbTransaction } from '@core-shared/db';
import {
	getArticlesMissingEntities,
	type MaintenanceCursor,
	pruneOrphanEntities,
	repairMissingArticleEntityLinks,
} from '@core-shared/entities/maintenance';
import { getEntityQualitySnapshot } from '@core-shared/entities/quality-report';
import type { Env } from '@core-shared/types';
import { enqueueArticleBatchProcess } from '@ingest/workflows/queue';

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

function parseMaintenanceSourceType(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
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
		return jsonError('BAD_REQUEST', 'Invalid before timestamp', 400, INTERNAL_CORS_HEADERS);
	}
	const cursor = parseMaintenanceCursor(body.cursor);
	if (body.cursor !== undefined && !cursor) {
		return jsonError('BAD_REQUEST', 'Invalid cursor', 400, INTERNAL_CORS_HEADERS);
	}
	const sourceType = parseMaintenanceSourceType(body.sourceType);
	if (body.sourceType !== undefined && !sourceType) {
		return jsonError('BAD_REQUEST', 'Invalid sourceType', 400, INTERNAL_CORS_HEADERS);
	}
	const includeLinked = body.includeLinked === true;
	const result = await withDbTransaction(env, 'repair entity links', (db) =>
		repairMissingArticleEntityLinks(db, limit, { before, cursor: cursor ?? undefined, includeLinked, sourceType: sourceType ?? undefined }),
	);
	return jsonData({ ...result, includeLinked, sourceType: sourceType ?? null }, INTERNAL_CORS_HEADERS);
}

export async function handleBackfillMissingEntities(request: Request, env: Env): Promise<Response> {
	const unauth = await requireAuth(request, env, INTERNAL_CORS_HEADERS);
	if (unauth) return unauth;

	const body = await parseJsonBody<{
		limit?: number;
		before?: string;
		cursor?: unknown;
		includeEmpty?: boolean;
		sourceType?: string;
	}>(request, INTERNAL_CORS_HEADERS);
	if (body instanceof Response) return body;

	const limit = boundedMaintenanceLimit(body.limit);
	const before = body.before?.trim() || undefined;
	if (before && Number.isNaN(Date.parse(before))) {
		return jsonError('BAD_REQUEST', 'Invalid before timestamp', 400, INTERNAL_CORS_HEADERS);
	}
	const cursor = parseMaintenanceCursor(body.cursor);
	if (body.cursor !== undefined && !cursor) {
		return jsonError('BAD_REQUEST', 'Invalid cursor', 400, INTERNAL_CORS_HEADERS);
	}
	const sourceType = parseMaintenanceSourceType(body.sourceType);
	if (body.sourceType !== undefined && !sourceType) {
		return jsonError('BAD_REQUEST', 'Invalid sourceType', 400, INTERNAL_CORS_HEADERS);
	}
	const articles = await withDbTransaction(env, 'select missing article entities', (db) =>
		getArticlesMissingEntities(db, limit, {
			before,
			cursor: cursor ?? undefined,
			includeEmpty: body.includeEmpty === true,
			sourceType: sourceType ?? undefined,
		}),
	);
	const articleIds = articles.map((article) => article.id);
	const nextBefore = articles.length === limit ? (articles.at(-1)?.publishedDate ?? null) : null;
	const nextCursor = articles.length === limit && articles.at(-1)?.publishedDate ? (articles.at(-1) as MaintenanceCursor) : null;
	if (articleIds.length) await enqueueArticleBatchProcess(env, articleIds);
	return jsonData(
		{
			articles: articleIds.length,
			articleIds,
			batch: articles,
			includeEmpty: body.includeEmpty === true,
			sourceType: sourceType ?? null,
			nextBefore,
			nextCursor,
		},
		INTERNAL_CORS_HEADERS,
	);
}

export async function handleEntityQuality(request: Request, env: Env): Promise<Response> {
	const unauth = await requireAuth(request, env, INTERNAL_CORS_HEADERS);
	if (unauth) return unauth;

	const body = await parseJsonBody<{ months?: number }>(request, INTERNAL_CORS_HEADERS);
	if (body instanceof Response) return body;

	const months = boundedMaintenanceLimit(body.months, 6, 24);
	const result = await withDbTransaction(env, 'entity quality snapshot', (db) => getEntityQualitySnapshot(db, { months }));
	return jsonData(result, INTERNAL_CORS_HEADERS);
}

export async function handlePruneOrphanEntities(request: Request, env: Env): Promise<Response> {
	const unauth = await requireAuth(request, env, INTERNAL_CORS_HEADERS);
	if (unauth) return unauth;

	const body = await parseJsonBody<{ limit?: number }>(request, INTERNAL_CORS_HEADERS);
	if (body instanceof Response) return body;

	const limit = boundedMaintenanceLimit(body.limit);
	const result = await withDbTransaction(env, 'prune orphan entities', (db) => pruneOrphanEntities(db, limit));
	return jsonData(result, INTERNAL_CORS_HEADERS);
}
