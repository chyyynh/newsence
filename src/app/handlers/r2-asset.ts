/**
 * Authenticated R2 asset handler with edge cache.
 *
 * Replaces the streaming code path in frontend's /api/r2/[...key] route. The
 * Next route stays as the auth gate (checks userFile ownership / citation
 * sharing) and 302s here with a short-TTL HMAC. We verify the signature, then
 * read the R2 binding directly and serve with caches.default.
 *
 * Sig input shape: `r2:${storageKey}:${exp}` (verifyR2KeySignature). Distinct
 * prefix from /proxy/ so a leaked /proxy/ sig can't be replayed here.
 *
 * Range support: parsed from the Range header into R2's R2Range shape and
 * forwarded to env.R2.get. Range requests bypass caches.default — caching 206
 * responses correctly requires keying on (url, range), not worth the cost
 * when only PDF.js byte-range streaming benefits.
 */

import { getProxySigningConfig, verifyR2KeySignature } from '../../lib/sign-url';
import type { Env, ExecutionContext } from '../../models/types';

const CONTENT_TYPE_FALLBACKS: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	avif: 'image/avif',
	pdf: 'application/pdf',
	mp4: 'video/mp4',
	webm: 'video/webm',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
};

function inferContentType(key: string): string {
	const ext = key.split('.').pop()?.toLowerCase() ?? '';
	return CONTENT_TYPE_FALLBACKS[ext] ?? 'application/octet-stream';
}

function corsPreflight(): Response {
	return new Response(null, {
		status: 204,
		headers: {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, OPTIONS',
			'Access-Control-Allow-Headers': 'Range',
			'Access-Control-Max-Age': '86400',
		},
	});
}

function parseRange(header: string | null): R2Range | null {
	if (!header) return null;
	const match = header.match(/^bytes=(\d*)-(\d*)$/);
	if (!match) return null;
	const [, startStr, endStr] = match;
	if (startStr === '' && endStr === '') return null;
	if (startStr === '') {
		const suffix = Number.parseInt(endStr, 10);
		if (!Number.isFinite(suffix) || suffix <= 0) return null;
		return { suffix };
	}
	const offset = Number.parseInt(startStr, 10);
	if (!Number.isFinite(offset) || offset < 0) return null;
	if (endStr === '') return { offset };
	const end = Number.parseInt(endStr, 10);
	if (!Number.isFinite(end) || end < offset) return null;
	return { offset, length: end - offset + 1 };
}

function resolveRange(range: R2Range, size: number): { start: number; end: number } {
	if ('suffix' in range) {
		const start = Math.max(0, size - range.suffix);
		return { start, end: size - 1 };
	}
	const start = range.offset ?? 0;
	const length = range.length ?? size - start;
	return { start, end: start + length - 1 };
}

function buildHeaders(object: R2ObjectBody, key: string, range: R2Range | null): Headers {
	const headers = new Headers();
	const contentType = object.httpMetadata?.contentType ?? inferContentType(key);
	headers.set('Content-Type', contentType);
	headers.set('Accept-Ranges', 'bytes');
	headers.set('Access-Control-Allow-Origin', '*');
	headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
	// `private` keeps user-scoped assets out of shared intermediaries
	// (corporate proxies, ISP caches). `caches.default` at the worker still
	// caches under our control because the Cache API treats max-age as the
	// authoritative TTL regardless of `private`.
	headers.set('Cache-Control', 'private, max-age=31536000, immutable');
	headers.set('ETag', object.httpEtag);

	// Force download for SVG to prevent stored XSS via embedded scripts.
	if (contentType === 'image/svg+xml') {
		headers.set('Content-Disposition', 'attachment');
	}

	if (range && object.range) {
		const { start, end } = resolveRange(object.range, object.size);
		headers.set('Content-Range', `bytes ${start}-${end}/${object.size}`);
		headers.set('Content-Length', String(end - start + 1));
	} else {
		headers.set('Content-Length', String(object.size));
	}

	return headers;
}

export async function handleR2Asset(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (request.method === 'OPTIONS') return corsPreflight();
	if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });

	const requestUrl = new URL(request.url);
	const match = requestUrl.pathname.match(/^\/r2\/(.+)$/);
	if (!match) return new Response('Expected: /r2/{key}', { status: 400 });

	let storageKey: string;
	try {
		storageKey = decodeURIComponent(match[1]);
	} catch {
		return new Response('Malformed key', { status: 400 });
	}
	if (!storageKey) return new Response('Missing key', { status: 400 });

	const signing = getProxySigningConfig(env);
	if (!signing) return new Response('Proxy signing not configured', { status: 503 });

	const sig = requestUrl.searchParams.get('sig');
	const exp = requestUrl.searchParams.get('exp');
	if (!sig || !exp) return new Response('Signature required', { status: 403 });

	const ok = await verifyR2KeySignature(storageKey, sig, exp, signing.secret);
	if (!ok) return new Response('Invalid or expired signature', { status: 403 });

	const range = parseRange(request.headers.get('Range'));

	// Strip sig/exp from the cache key — they rotate every 15min (quantize
	// bucket) on the same underlying object, and would otherwise force a miss
	// every bucket roll. Range requests skip cache entirely.
	const cacheUrl = new URL(request.url);
	cacheUrl.search = '';
	const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });

	if (!range) {
		const hit = await caches.default.match(cacheKey);
		if (hit) return hit;
	}

	let object: R2ObjectBody | null;
	try {
		object = await env.R2.get(storageKey, range ? { range } : undefined);
	} catch (err) {
		const name = (err as { name?: string }).name;
		if (name === 'InvalidRange') {
			return new Response(null, { status: 416, headers: { 'Accept-Ranges': 'bytes' } });
		}
		console.error(
			JSON.stringify({
				message: 'r2 get error',
				key: storageKey,
				error: err instanceof Error ? err.message : String(err),
				name,
			}),
		);
		return new Response('R2 read error', { status: 502 });
	}

	if (!object) return new Response('Not found', { status: 404 });

	const headers = buildHeaders(object, storageKey, range);
	const status = range ? 206 : 200;
	const response = new Response(object.body, { status, headers });

	if (!range) {
		ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
	}
	return response;
}
