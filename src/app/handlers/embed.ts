import { logError } from '../../infra/log';
import type { Env } from '../../models/types';

const CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
};

const EMBEDDING_MODEL = '@cf/baai/bge-m3';
const EMBED_MAX_TEXT = 8000;

function normalizeEmbedding(v: number[]): number[] {
	const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
	return norm === 0 ? v : v.map((x) => x / norm);
}

export async function handleEmbed(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

	const body = (await request.json().catch(() => ({}))) as { text?: string; texts?: string[] };
	const input = body.texts || (body.text ? [body.text] : []);
	if (input.length === 0) {
		return Response.json({ error: 'No text provided' }, { status: 400, headers: CORS_HEADERS });
	}

	const sanitized = input.map((t) => t.trim().slice(0, EMBED_MAX_TEXT));

	try {
		const result = (await env.AI.run(EMBEDDING_MODEL as Parameters<Ai['run']>[0], { text: sanitized })) as {
			data: number[][];
		};
		return Response.json(
			{ embeddings: result.data.map(normalizeEmbedding), model: EMBEDDING_MODEL, dimensions: 1024 },
			{ headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
		);
	} catch (error) {
		logError('EMBED', 'Generation failed', { error: String(error) });
		return Response.json(
			{ error: 'Embedding generation failed', details: error instanceof Error ? error.message : 'Unknown error' },
			{ status: 500, headers: CORS_HEADERS },
		);
	}
}
