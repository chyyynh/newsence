import { parseJsonBody, requireAuth } from '@shared/auth/middleware';
import { logError } from '@shared/log';
import { MAGIC_SNIFF_BYTES, sniffMediaType } from '@shared/magic-bytes';
import { extensionFromMime } from '@shared/mime';
import type { Env } from '@shared/types';
import { MAX_UPLOAD_BYTES } from '@shared/upload';
import { extractSource } from '../extract';
import { TMP_SCRAPE_PREFIX } from '../workflows/scrape.workflow';

// HTTP surface for content extraction (Firecrawl-style). All routes share the
// same wildcard CORS and 10 MB body cap. The actual extraction lives in
// extractSource (sync) / ScrapeWorkflow (async); this file is just the edge.
const CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, X-Internal-Token, Authorization',
};

// POST /scrape — synchronous, stateless content extraction. Accepts either
// `{ "url": "..." }` (JSON) or raw file bytes (`--data-binary`). Returns
// NormalizedContent without touching R2/DB and without AI — the fast path.
// Large/slow inputs (OCR, big PDFs) should use the async POST /scrape/jobs.
export async function handleScrape(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

	const unauth = await requireAuth(request, env, CORS_HEADERS);
	if (unauth) return unauth;

	try {
		const input = await readScrapeInput(request);
		if (input instanceof Response) return input;
		return Response.json(await extractSource(env, input), { headers: CORS_HEADERS });
	} catch (error) {
		logError('SCRAPE', 'Extraction failed', { error: String(error) });
		return Response.json(
			{ error: 'Extraction failed', details: error instanceof Error ? error.message : 'Unknown error' },
			{ status: 500, headers: CORS_HEADERS },
		);
	}
}

// POST /scrape/jobs — async, non-persisting parse. URL → workflow param; raw
// bytes → staged to a temp R2 key (deleted by the workflow). Returns a job id;
// poll GET /scrape/jobs/:id for the result. Use this for large/slow inputs that
// would exceed the sync /scrape request budget.
export async function handleScrapeJobCreate(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

	const unauth = await requireAuth(request, env, CORS_HEADERS);
	if (unauth) return unauth;

	try {
		const params = await buildJobParams(request, env);
		if (params instanceof Response) return params;

		const instance = await env.SCRAPE_WORKFLOW.create({ params });
		return Response.json({ jobId: instance.id, status: 'queued' }, { status: 202, headers: CORS_HEADERS });
	} catch (error) {
		logError('SCRAPE_JOB', 'create failed', { error: String(error) });
		return Response.json(
			{ error: 'Failed to create scrape job', details: error instanceof Error ? error.message : 'Unknown error' },
			{ status: 500, headers: CORS_HEADERS },
		);
	}
}

// Parse a scrape request body into a normalized input: `{url}` (JSON) or raw
// `{bytes}` (validated against the size cap). Shared by handleScrape and the
// job-create path. Returns a Response on bad input.
async function readScrapeInput(request: Request): Promise<{ kind: 'url'; url: string } | { kind: 'bytes'; bytes: Uint8Array } | Response> {
	const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';

	if (contentType.startsWith('application/json')) {
		const body = await parseJsonBody<{ url?: string }>(request, CORS_HEADERS);
		if (body instanceof Response) return body;
		const url = body.url?.trim();
		if (!url) return Response.json({ error: 'Missing "url"' }, { status: 400, headers: CORS_HEADERS });
		return { kind: 'url', url };
	}

	const bytes = new Uint8Array(await request.arrayBuffer());
	if (bytes.byteLength === 0)
		return Response.json({ error: 'Empty body — POST {url} JSON or raw bytes' }, { status: 400, headers: CORS_HEADERS });
	if (bytes.byteLength > MAX_UPLOAD_BYTES)
		return Response.json({ error: `Body exceeds ${MAX_UPLOAD_BYTES} bytes` }, { status: 413, headers: CORS_HEADERS });
	return { kind: 'bytes', bytes };
}

// For the async job: a URL passes straight through as a workflow param; raw
// bytes are staged to a temp R2 key (the workflow deletes it), since bytes can't
// fit in Workflow params.
async function buildJobParams(request: Request, env: Env): Promise<{ kind: 'url'; url: string } | { kind: 'r2'; key: string } | Response> {
	const input = await readScrapeInput(request);
	if (input instanceof Response || input.kind === 'url') return input;

	const sniffed = sniffMediaType(input.bytes.subarray(0, MAGIC_SNIFF_BYTES));
	if (!sniffed) return Response.json({ error: 'Unrecognized file type' }, { status: 415, headers: CORS_HEADERS });

	const key = `${TMP_SCRAPE_PREFIX}${crypto.randomUUID()}.${extensionFromMime(sniffed)}`;
	await env.R2.put(key, input.bytes, { httpMetadata: { contentType: sniffed } });
	return { kind: 'r2', key };
}

// GET /scrape/jobs/:id — poll job status. `result` carries the NormalizedContent
// once the Workflow completes (from its `output`).
export async function handleScrapeJobStatus(request: Request, jobId: string, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

	const unauth = await requireAuth(request, env, CORS_HEADERS);
	if (unauth) return unauth;

	try {
		const instance = await env.SCRAPE_WORKFLOW.get(jobId);
		const { status, error, output } = await instance.status();
		return Response.json({ status, ...(output ? { result: output } : {}), ...(error ? { error } : {}) }, { headers: CORS_HEADERS });
	} catch {
		return Response.json({ error: `Job not found: ${jobId}` }, { status: 404, headers: CORS_HEADERS });
	}
}
