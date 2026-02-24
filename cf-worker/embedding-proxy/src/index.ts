/**
 * Embedding Proxy Worker
 * 使用 Cloudflare Workers AI 生成文本 embedding
 * 模型: @cf/baai/bge-m3 (1024 維度，多語言)
 */

interface Env {
	AI: Ai;
}

interface EmbeddingRequest {
	text?: string;
	texts?: string[];
}

interface AiEmbeddingResult {
	shape: number[];
	data: number[][];
}

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
};

/**
 * L2 正規化向量
 */
function normalizeVector(embedding: number[]): number[] {
	const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
	if (norm === 0) return embedding;
	return embedding.map((val) => val / norm);
}

/**
 * 生成 embeddings
 */
async function generateEmbeddings(texts: string[], ai: Ai): Promise<number[][]> {
	const result = (await ai.run('@cf/baai/bge-m3', {
		text: texts,
	})) as AiEmbeddingResult;

	return result.data.map((embedding) => normalizeVector(embedding));
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		// Handle CORS preflight
		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: CORS_HEADERS });
		}

		if (request.method !== 'POST') {
			return new Response(
				JSON.stringify({
					error: 'Method not allowed',
					usage: 'POST / with { "text": "string" } or { "texts": ["string1", "string2"] }',
				}),
				{
					status: 405,
					headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
				},
			);
		}

		try {
			const body: EmbeddingRequest = await request.json();
			const { text, texts } = body;

			// 支援單筆或批量
			const input = texts || (text ? [text] : []);

			if (input.length === 0) {
				return new Response(JSON.stringify({ error: 'No text provided' }), {
					status: 400,
					headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
				});
			}

			// 截斷過長文本
			const sanitizedInput = input.map((t) => t.trim().slice(0, 8000));

			// 呼叫 Workers AI (bge-m3 多語言模型)
			const embeddings = await generateEmbeddings(sanitizedInput, env.AI);

			return new Response(
				JSON.stringify({
					embeddings,
					model: '@cf/baai/bge-m3',
					dimensions: 1024,
				}),
				{
					headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
				},
			);
		} catch (error) {
			console.error('Embedding generation failed:', error);
			return new Response(
				JSON.stringify({
					error: 'Embedding generation failed',
					details: error instanceof Error ? error.message : 'Unknown error',
				}),
				{
					status: 500,
					headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
				},
			);
		}
	},
};
