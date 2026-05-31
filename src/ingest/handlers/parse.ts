import { requireAuth } from '@shared/auth/middleware';
import { logError } from '@shared/log';
import type { Env } from '@shared/types';
import { parsePdf } from '../workflows/steps/pdf-extraction';

const CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, X-Internal-Token, Authorization',
};

// Mirrors the upload cap in ingest/blob.ts.
const MAX_BYTES = 10 * 1024 * 1024;

// POST /parse — stateless PDF text extraction. Body is the raw PDF bytes
// (`--data-binary @file.pdf`). Returns LiteParse output without touching R2/DB,
// so it doubles as the smoke test for the WASM path in the real Worker runtime.
export async function handleParse(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

	const unauth = await requireAuth(request, env, CORS_HEADERS);
	if (unauth) return unauth;

	const bytes = new Uint8Array(await request.arrayBuffer());
	if (bytes.byteLength === 0) {
		return Response.json({ error: 'Empty body — POST raw PDF bytes' }, { status: 400, headers: CORS_HEADERS });
	}
	if (bytes.byteLength > MAX_BYTES) {
		return Response.json({ error: `PDF exceeds ${MAX_BYTES} bytes` }, { status: 413, headers: CORS_HEADERS });
	}

	try {
		const { text, status, pages, chars } = await parsePdf(bytes);
		return Response.json({ text, status, pages, chars }, { headers: CORS_HEADERS });
	} catch (error) {
		logError('PARSE', 'PDF parse failed', { error: String(error) });
		return Response.json(
			{ error: 'PDF parse failed', details: error instanceof Error ? error.message : 'Unknown error' },
			{ status: 500, headers: CORS_HEADERS },
		);
	}
}
