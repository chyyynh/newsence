import { parseJsonBody } from '@shared/auth/middleware';
import type { Env } from '@shared/types';
import { EMBED_CORS_HEADERS } from './cors';

const EMBEDDING_MODEL = '@cf/baai/bge-m3';
const EMBED_MAX_TEXT = 8000;

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
