import { parseJsonBody, requireAuth } from '@shared/auth/middleware';
import type { Env } from '@shared/types';
import { rankCorpusArticleIds, relatedCorpusArticleIds } from '../../corpus';
import { INTERNAL_CORS_HEADERS } from './cors';

const SEARCH_LIMIT_MAX = 500;

export async function handleSearch(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { headers: INTERNAL_CORS_HEADERS });

	const unauth = await requireAuth(request, env, INTERNAL_CORS_HEADERS);
	if (unauth) return unauth;

	const body = await parseJsonBody<{ query?: string; limit?: number }>(request, INTERNAL_CORS_HEADERS);
	if (body instanceof Response) return body;

	const query = body.query?.trim();
	if (!query) {
		return Response.json({ success: true, data: { results: [] } }, { headers: INTERNAL_CORS_HEADERS });
	}
	const limit = Math.min(Math.max(Math.trunc(body.limit ?? 100), 1), SEARCH_LIMIT_MAX);

	try {
		const results = await rankCorpusArticleIds(env, query, limit);
		return Response.json(
			{ success: true, data: { results } },
			{ headers: { ...INTERNAL_CORS_HEADERS, 'Content-Type': 'application/json' } },
		);
	} catch (error) {
		console.error({ tag: 'SEARCH', msg: 'hybrid search failed', error: error instanceof Error ? error.message : String(error) });
		return Response.json(
			{ success: false, error: { code: 'SEARCH_FAILED', message: 'Search failed' } },
			{ status: 500, headers: INTERNAL_CORS_HEADERS },
		);
	}
}

export async function handleRelated(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { headers: INTERNAL_CORS_HEADERS });

	const unauth = await requireAuth(request, env, INTERNAL_CORS_HEADERS);
	if (unauth) return unauth;

	const body = await parseJsonBody<{ id?: string; type?: string; limit?: number; offset?: number }>(request, INTERNAL_CORS_HEADERS);
	if (body instanceof Response) return body;

	const id = body.id?.trim();
	const type = body.type === 'user_file' ? 'user_file' : 'article';
	if (!id) {
		return Response.json(
			{ success: false, error: { code: 'BAD_REQUEST', message: 'Missing seed id' } },
			{ status: 400, headers: INTERNAL_CORS_HEADERS },
		);
	}
	const limit = Math.min(Math.max(Math.trunc(body.limit ?? 12), 1), SEARCH_LIMIT_MAX);
	const offset = Math.max(Math.trunc(body.offset ?? 0), 0);

	try {
		const ids = await relatedCorpusArticleIds(env, { id, type }, limit, offset);
		return Response.json({ success: true, data: { ids } }, { headers: { ...INTERNAL_CORS_HEADERS, 'Content-Type': 'application/json' } });
	} catch (error) {
		console.error({ tag: 'SEARCH', msg: 'related search failed', error: error instanceof Error ? error.message : String(error) });
		return Response.json(
			{ success: false, error: { code: 'SEARCH_FAILED', message: 'Related search failed' } },
			{ status: 500, headers: INTERNAL_CORS_HEADERS },
		);
	}
}
