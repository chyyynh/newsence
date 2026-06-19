import { parseJsonBody, requireAuth } from '@shared/auth';
import type { Env } from '@shared/types';
import { rankCorpusArticleIds, relatedCorpusArticleIds } from '../corpus';

export const INTERNAL_CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, X-Internal-Token, Authorization',
};

export const EMBED_CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
};

const EMBEDDING_MODEL = '@cf/baai/bge-m3';
const EMBED_MAX_TEXT = 8000;
const SEARCH_LIMIT_MAX = 500;

export async function handleEmbed(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { headers: EMBED_CORS_HEADERS });

	const body = await parseJsonBody<{ text?: string; texts?: string[] }>(request, EMBED_CORS_HEADERS);
	if (body instanceof Response) return body;
	const input = body.texts || (body.text ? [body.text] : []);
	if (input.length === 0) {
		return Response.json({ error: 'No text provided' }, { status: 400, headers: EMBED_CORS_HEADERS });
	}

	const sanitized = input.map((t) => t.trim().slice(0, EMBED_MAX_TEXT));

	try {
		const result = (await env.AI.run(EMBEDDING_MODEL as Parameters<Ai['run']>[0], { text: sanitized })) as {
			data: number[][];
		};
		return Response.json(
			{ embeddings: result.data, model: EMBEDDING_MODEL, dimensions: 1024 },
			{ headers: { ...EMBED_CORS_HEADERS, 'Content-Type': 'application/json' } },
		);
	} catch (error) {
		console.error({ tag: 'EMBED', msg: 'Generation failed', error: String(error) });
		return Response.json(
			{ error: 'Embedding generation failed', details: error instanceof Error ? error.message : 'Unknown error' },
			{ status: 500, headers: EMBED_CORS_HEADERS },
		);
	}
}

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

export function handleWorkflowStream(instanceId: string, env: Env): Response {
	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const encoder = new TextEncoder();
	const writeEvent = (data: object) => writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

	(async () => {
		try {
			for (let i = 0; i < 40; i++) {
				await new Promise((r) => setTimeout(r, 3000));

				const instance = await env.MONITOR_WORKFLOW.get(instanceId);
				const { status, error } = await instance.status();
				const isTerminal = status === 'complete' || status === 'errored' || status === 'terminated';

				if (status === 'complete') {
					await writeEvent({ status: 'complete' });
					return;
				}

				await writeEvent({ status, error });
				if (isTerminal) return;
			}
		} catch (err) {
			await writeEvent({ status: 'error', error: String(err) });
		} finally {
			await writer.close();
		}
	})();

	return new Response(readable, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		},
	});
}
