// HTTP /search — corpus hybrid ranking for the frontend (the search bar + MCP).
// Vercel can't use the CORE service binding, so these callers reach the same
// ranking over HTTP. Returns id→score pairs (not hydrated articles): the caller
// hydrates + applies its own filters, exactly how the RPC `searchArticles`
// layers `rankArticles` under hydration. This makes core-worker the single owner
// of the hybrid ranking — the frontend no longer duplicates the SQL.

import { parseJsonBody, requireAuth } from '@shared/auth/middleware';
import { createDbClient } from '@shared/db/articles';
import { logError } from '@shared/log';
import type { Env } from '@shared/types';
import { searchArticles as rankArticles, relatedArticles } from '../search';

const CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, X-Internal-Token, Authorization',
};

const SEARCH_LIMIT_MAX = 500;

export async function handleSearch(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

	const unauth = await requireAuth(request, env, CORS_HEADERS);
	if (unauth) return unauth;

	const body = await parseJsonBody<{ query?: string; limit?: number }>(request, CORS_HEADERS);
	if (body instanceof Response) return body;

	const query = body.query?.trim();
	if (!query) {
		return Response.json({ success: true, data: { results: [] } }, { headers: CORS_HEADERS });
	}
	const limit = Math.min(Math.max(Math.trunc(body.limit ?? 100), 1), SEARCH_LIMIT_MAX);

	const client = await createDbClient(env);
	try {
		const ranks = await rankArticles(client, env, query, limit);
		const results = [...ranks].map(([id, score]) => ({ id, score }));
		return Response.json({ success: true, data: { results } }, { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
	} catch (error) {
		logError('SEARCH', 'hybrid search failed', { error: error instanceof Error ? error.message : String(error) });
		return Response.json(
			{ success: false, error: { code: 'SEARCH_FAILED', message: 'Search failed' } },
			{ status: 500, headers: CORS_HEADERS },
		);
	} finally {
		await client.end().catch(() => {});
	}
}

// POST /search/related — pgvector nearest-neighbour article ids for a seed
// (article or user_file). The caller (frontend) gates readability of the seed
// and hydrates/paginates; this only ranks an already-authorized seed.
export async function handleRelated(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

	const unauth = await requireAuth(request, env, CORS_HEADERS);
	if (unauth) return unauth;

	const body = await parseJsonBody<{ id?: string; type?: string; limit?: number; offset?: number }>(request, CORS_HEADERS);
	if (body instanceof Response) return body;

	const id = body.id?.trim();
	const type = body.type === 'user_file' ? 'user_file' : 'article';
	if (!id) {
		return Response.json(
			{ success: false, error: { code: 'BAD_REQUEST', message: 'Missing seed id' } },
			{ status: 400, headers: CORS_HEADERS },
		);
	}
	const limit = Math.min(Math.max(Math.trunc(body.limit ?? 12), 1), SEARCH_LIMIT_MAX);
	const offset = Math.max(Math.trunc(body.offset ?? 0), 0);

	const client = await createDbClient(env);
	try {
		const ids = await relatedArticles(client, { id, type }, limit, offset);
		return Response.json({ success: true, data: { ids } }, { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
	} catch (error) {
		logError('SEARCH', 'related search failed', { error: error instanceof Error ? error.message : String(error) });
		return Response.json(
			{ success: false, error: { code: 'SEARCH_FAILED', message: 'Related search failed' } },
			{ status: 500, headers: CORS_HEADERS },
		);
	} finally {
		await client.end().catch(() => {});
	}
}
