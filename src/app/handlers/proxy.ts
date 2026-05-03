/**
 * Public media passthrough proxy with edge cache + Cloudflare Images binding.
 *
 * Auth model: HMAC-signed URLs (?sig=&exp=) minted server-side at ingest.
 * Falls back to a small host allowlist when the signing secret isn't set or
 * the request is unsigned — covers legacy rows + platform-metadata URLs and
 * lets a half-deployed rollout keep rendering. Drop the allowlist once
 * everything is signed.
 *
 * `env.IMAGES` is used over `cf.image` fetch options because the latter is
 * silently ignored on workers.dev domains. Every IMAGES binding call bills as
 * a transform, so transformed responses are persisted in R2 and then mirrored
 * into caches.default. This keeps misses in different colos from repeatedly
 * burning transformations for the same source/options pair.
 *
 * Usage: GET /proxy/{options}/{mediaUrl}?sig={hex}&exp={unix}
 *   options — comma-separated key=value (w, q). Pass `passthrough` for raw proxying.
 */

import { getProxySigningConfig, verifyProxySignature } from '../../lib/sign-url';
import type { Env, ExecutionContext } from '../../models/types';

const LEGACY_ALLOWED_HOSTS = new Set([
	'pbs.twimg.com',
	'video.twimg.com',
	'abs.twimg.com',
	'i.ytimg.com',
	'yt3.ggpht.com',
	'cdn.openai.com',
	'substackcdn.com',
]);

const VIDEO_HOSTS = new Set(['video.twimg.com']);
// Must stay in sync with frontend/next.config.ts images.deviceSizes/imageSizes.
// The options segment is intentionally unsigned so Next can choose a width at
// render time; this allowlist prevents leaked signed URLs from being used to
// mint arbitrary width/quality combinations and burn transformation quota.
const ALLOWED_TRANSFORM_WIDTHS = new Set([256, 1280, 1920]);
const ALLOWED_QUALITY = 75;
const TRANSFORM_CACHE_PREFIX = 'image-transform-cache/v1';

type ParsedProxyOptions =
	| { kind: 'passthrough' }
	| {
			kind: 'transform';
			width: number;
			quality: number;
	  };

function isLegacyAllowed(url: URL): boolean {
	if (url.protocol !== 'https:') return false;
	return LEGACY_ALLOWED_HOSTS.has(url.hostname);
}

function parseRawOptions(optionsStr: string): Record<string, string> {
	const opts: Record<string, string> = {};
	for (const part of optionsStr.split(',')) {
		const idx = part.indexOf('=');
		if (idx > 0) opts[part.slice(0, idx)] = part.slice(idx + 1);
	}
	return opts;
}

function parseProxyOptions(optionsStr: string): ParsedProxyOptions | Response {
	if (optionsStr === 'passthrough') return { kind: 'passthrough' };

	const raw = parseRawOptions(optionsStr);
	const keys = Object.keys(raw);
	if (keys.length === 0 || keys.some((key) => key !== 'w' && key !== 'q')) {
		return new Response('Unsupported image options', { status: 400 });
	}

	const width = Number.parseInt(raw.w ?? '', 10);
	if (!ALLOWED_TRANSFORM_WIDTHS.has(width)) return new Response('Unsupported image width', { status: 400 });

	const quality = raw.q ? Number.parseInt(raw.q, 10) : ALLOWED_QUALITY;
	if (quality !== ALLOWED_QUALITY) return new Response('Unsupported image quality', { status: 400 });

	return { kind: 'transform', width, quality };
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

async function fetchUpstream(parsed: URL, range: string | null): Promise<Response> {
	const headers: HeadersInit = { 'User-Agent': 'Mozilla/5.0 (compatible; NewsenceProxy/1.0)' };
	if (range) headers.Range = range;
	return fetch(parsed.toString(), {
		headers,
		cf: { cacheEverything: true, cacheTtl: 60 * 60 * 24 * 30 },
	});
}

function videoPassthrough(upstream: Response): Response {
	const headers = new Headers();
	headers.set('Access-Control-Allow-Origin', '*');
	headers.set('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
	headers.set('Cache-Control', 'public, max-age=604800');
	for (const key of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']) {
		const value = upstream.headers.get(key);
		if (value) headers.set(key, value);
	}
	return new Response(upstream.body, { status: upstream.status, headers });
}

function mediaPassthrough(upstream: Response): Response {
	const headers = new Headers();
	headers.set('Access-Control-Allow-Origin', '*');
	headers.set('Access-Control-Expose-Headers', 'Content-Length');
	headers.set('Cache-Control', 'public, max-age=604800');
	for (const key of ['Content-Type', 'Content-Length', 'ETag', 'Last-Modified']) {
		const value = upstream.headers.get(key);
		if (value) headers.set(key, value);
	}
	return new Response(upstream.body, { status: upstream.status, headers });
}

async function sha256Hex(input: string): Promise<string> {
	const bytes = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

async function transformCacheKey(sourceUrl: URL, options: Extract<ParsedProxyOptions, { kind: 'transform' }>): Promise<string> {
	const hash = await sha256Hex(
		JSON.stringify({ source: sourceUrl.toString(), width: options.width, quality: options.quality, format: 'webp' }),
	);
	return `${TRANSFORM_CACHE_PREFIX}/${hash}.webp`;
}

function transformedResponse(body: BodyInit | null, headersSource?: Headers): Response {
	const headers = new Headers(headersSource);
	headers.set('Access-Control-Allow-Origin', '*');
	headers.set('Content-Type', 'image/webp');
	headers.set('Cache-Control', 'public, max-age=31536000, immutable');
	return new Response(body, { status: 200, headers });
}

async function readR2CachedTransform(env: Env, key: string): Promise<Response | null> {
	const object = await env.R2.get(key);
	if (!object) return null;

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set('ETag', object.httpEtag);
	return transformedResponse(object.body, headers);
}

async function writeR2CachedTransform(env: Env, key: string, body: ArrayBuffer): Promise<void> {
	await env.R2.put(key, body, {
		httpMetadata: {
			contentType: 'image/webp',
			cacheControl: 'public, max-age=31536000, immutable',
		},
	});
}

export async function handleProxy(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (request.method === 'OPTIONS') return corsPreflight();

	const requestUrl = new URL(request.url);
	const match = requestUrl.pathname.match(/^\/proxy\/([^/]+)\/(.+)$/);
	if (!match) return new Response('Expected: /proxy/{options}/{mediaUrl}', { status: 400 });

	const [, optionsStr, encodedUrl] = match;
	let parsed: URL;
	try {
		parsed = new URL(decodeURIComponent(encodedUrl));
	} catch {
		return new Response('Invalid media URL', { status: 400 });
	}
	if (parsed.protocol !== 'https:') return new Response('Only https upstreams allowed', { status: 403 });

	const sig = requestUrl.searchParams.get('sig');
	const exp = requestUrl.searchParams.get('exp');
	const signing = getProxySigningConfig(env);
	if (signing && sig && exp) {
		const ok = await verifyProxySignature(encodedUrl, sig, exp, signing.secret);
		if (!ok) return new Response('Invalid or expired signature', { status: 403 });
	} else if (!isLegacyAllowed(parsed)) {
		return new Response('URL not allowed', { status: 403 });
	}

	try {
		const options = parseProxyOptions(optionsStr);
		if (options instanceof Response) return options;

		if (VIDEO_HOSTS.has(parsed.hostname)) {
			const upstream = await fetchUpstream(parsed, request.headers.get('Range'));
			if (!upstream.ok && upstream.status !== 206) {
				return new Response(`Upstream error: ${upstream.statusText}`, {
					status: upstream.status,
					headers: { 'Access-Control-Allow-Origin': '*' },
				});
			}
			return videoPassthrough(upstream);
		}

		const cache = caches.default;
		const r2CacheKey = options.kind === 'transform' ? await transformCacheKey(parsed, options) : null;
		const cacheKey = new Request(
			r2CacheKey
				? `${requestUrl.origin}/proxy-cache/${r2CacheKey}`
				: `${requestUrl.origin}/proxy-cache/passthrough/${encodeURIComponent(parsed.toString())}`,
			{ method: 'GET' },
		);
		const hit = await cache.match(cacheKey);
		if (hit) return hit;

		if (r2CacheKey) {
			const r2Hit = await readR2CachedTransform(env, r2CacheKey);
			if (r2Hit) {
				ctx.waitUntil(cache.put(cacheKey, r2Hit.clone()));
				return r2Hit;
			}
		}

		const upstream = await fetchUpstream(parsed, null);
		if (!upstream.ok || !upstream.body) {
			return new Response(`Upstream error: ${upstream.statusText}`, {
				status: upstream.status,
				headers: { 'Access-Control-Allow-Origin': '*' },
			});
		}

		if (options.kind === 'passthrough') {
			const response = mediaPassthrough(upstream);
			ctx.waitUntil(cache.put(cacheKey, response.clone()));
			return response;
		}

		const transform: ImageTransform = { fit: 'scale-down', width: options.width };
		const result = await env.IMAGES.input(upstream.body).transform(transform).output({ format: 'image/webp', quality: options.quality });
		const base = result.response();
		const body = await base.arrayBuffer();
		const response = transformedResponse(body, base.headers);
		if (r2CacheKey) ctx.waitUntil(writeR2CachedTransform(env, r2CacheKey, body.slice(0)));
		ctx.waitUntil(cache.put(cacheKey, response.clone()));
		return response;
	} catch (err) {
		console.error('Proxy error:', err);
		return new Response('Proxy error', {
			status: 502,
			headers: { 'Access-Control-Allow-Origin': '*' },
		});
	}
}
