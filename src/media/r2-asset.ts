/**
 * Authenticated R2 asset handler with edge cache.
 *
 * Replaces the streaming code path in frontend's /api/media/asset/[...key] route. The
 * Next route stays as the auth gate (checks userFile ownership / citation
 * sharing) and 302s here with a short-TTL HMAC. We verify the signature, then
 * read the R2 binding directly.
 *
 * Sig input shape: `r2:${storageKey}:${exp}` (verifyR2KeySignature). Distinct
 * prefix from /media/external/ so a leaked external-media sig can't be replayed here.
 *
 * Range support: forwarded as request headers to env.R2.get so the R2 binding
 * owns HTTP Range parsing.
 */

import type { Env } from '@shared/types';
import { getProxySigningSecret, verifyR2KeySignature } from './sign-url';

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
const SIGNED_ASSET_BROWSER_CACHE_MAX_AGE_SEC = 60 * 60;

let unsetCorsWarningLogged = false;

function parseOriginAllowlist(env: Env): string[] | null {
	const list = env.APP_ORIGINS?.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	return list?.length ? list : null;
}

function warnCorsAllowlistUnset(): void {
	if (unsetCorsWarningLogged) return;
	console.warn({ tag: 'R2_ASSET', msg: 'APP_ORIGINS unset, media asset CORS falls back to *' });
	unsetCorsWarningLogged = true;
}

function getCorsHeaders(request: Request, env: Env): Record<string, string> {
	const allowlist = parseOriginAllowlist(env);
	if (!allowlist) {
		warnCorsAllowlistUnset();
		return { 'Access-Control-Allow-Origin': '*' };
	}

	const origin = request.headers.get('Origin');
	if (origin && allowlist.includes(origin)) {
		return {
			'Access-Control-Allow-Origin': origin,
			Vary: 'Origin',
		};
	}

	return { Vary: 'Origin' };
}

function inferContentType(key: string): string {
	const ext = key.split('.').pop()?.toLowerCase() ?? '';
	return CONTENT_TYPE_FALLBACKS[ext] ?? 'application/octet-stream';
}

function corsPreflight(request: Request, env: Env): Response {
	return new Response(null, {
		status: 204,
		headers: {
			...getCorsHeaders(request, env),
			'Access-Control-Allow-Methods': 'GET, OPTIONS',
			'Access-Control-Allow-Headers': 'Range',
			'Access-Control-Max-Age': '86400',
		},
	});
}

function resolveRange(range: R2Range, size: number): { start: number; end: number } {
	if ('suffix' in range) {
		const start = Math.max(0, size - range.suffix);
		return { start, end: size - 1 };
	}
	const start = range.offset ?? 0;
	const length = range.length ?? size - start;
	return { start, end: Math.min(size - 1, start + length - 1) };
}

function buildHeaders(object: R2ObjectBody, key: string, cors: Record<string, string>): Headers {
	const headers = new Headers();
	object.writeHttpMetadata(headers);
	if (!headers.has('Content-Type')) headers.set('Content-Type', inferContentType(key));
	headers.set('Accept-Ranges', 'bytes');
	for (const [k, v] of Object.entries(cors)) {
		headers.set(k, v);
	}
	headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
	// Keep browser caching aligned with the 1h signed URL. The worker still
	// verifies every uncached request before reading private R2 objects.
	headers.set('Cache-Control', `private, max-age=${SIGNED_ASSET_BROWSER_CACHE_MAX_AGE_SEC}`);
	headers.set('ETag', object.httpEtag);

	// Force download for SVG to prevent stored XSS via embedded scripts.
	const contentType = headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase();
	if (contentType === 'image/svg+xml') {
		headers.set('Content-Disposition', 'attachment');
	}

	if (object.range) {
		const { start, end } = resolveRange(object.range, object.size);
		headers.set('Content-Range', `bytes ${start}-${end}/${object.size}`);
		headers.set('Content-Length', String(end - start + 1));
	} else {
		headers.set('Content-Length', String(object.size));
	}

	return headers;
}

export async function handleR2Asset(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') return corsPreflight(request, env);
	if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });

	const requestUrl = new URL(request.url);
	const match = requestUrl.pathname.match(/^\/media\/asset\/(.+)$/);
	if (!match) return new Response('Expected: /media/asset/{key}', { status: 400 });

	let storageKey: string;
	try {
		storageKey = decodeURIComponent(match[1]);
	} catch {
		return new Response('Malformed key', { status: 400 });
	}
	if (!storageKey) return new Response('Missing key', { status: 400 });

	const signingSecret = getProxySigningSecret(env);
	if (!signingSecret) return new Response('Proxy signing not configured', { status: 503 });

	const sig = requestUrl.searchParams.get('sig');
	const exp = requestUrl.searchParams.get('exp');
	if (!sig || !exp) return new Response('Signature required', { status: 403 });

	const ok = await verifyR2KeySignature(storageKey, sig, exp, signingSecret);
	if (!ok) return new Response('Invalid or expired signature', { status: 403 });

	let object: R2ObjectBody | null;
	try {
		object = await env.R2.get(storageKey, request.headers.has('Range') ? { range: request.headers } : undefined);
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

	const headers = buildHeaders(object, storageKey, getCorsHeaders(request, env));
	const status = object.range ? 206 : 200;
	return new Response(object.body, { status, headers });
}
