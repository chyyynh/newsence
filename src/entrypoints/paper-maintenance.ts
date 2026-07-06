// ─────────────────────────────────────────────────────────────
// Internal /papers/* maintenance endpoints (registered in http.ts).
// ─────────────────────────────────────────────────────────────

import { INTERNAL_CORS_HEADERS, jsonData, parseJsonBody, requireAuth } from '@core-shared/auth';
import { backfillPaperGraph, parseBackfillTable } from '@core-shared/papers/backfill';
import type { Env } from '@core-shared/types';

function boundedLimit(value: unknown, fallback = 100, max = 500): number {
	return Math.min(Math.max(Number.isFinite(value) ? Math.trunc(Number(value)) : fallback, 1), max);
}

export async function handleBackfillPaperGraph(request: Request, env: Env): Promise<Response> {
	const unauth = await requireAuth(request, env, INTERNAL_CORS_HEADERS);
	if (unauth) return unauth;

	const body = await parseJsonBody<{ limit?: number; table?: string; cursorId?: string }>(request, INTERNAL_CORS_HEADERS);
	if (body instanceof Response) return body;

	const cursorId = typeof body.cursorId === 'string' && body.cursorId.trim() ? body.cursorId.trim() : null;
	const result = await backfillPaperGraph(env, {
		table: parseBackfillTable(body.table),
		limit: boundedLimit(body.limit),
		cursorId,
	});
	return jsonData(result, INTERNAL_CORS_HEADERS);
}
