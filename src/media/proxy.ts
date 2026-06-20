/**
 * Public media passthrough proxy with edge cache + Cloudflare Images binding.
 *
 * Auth: every request must carry an HMAC-signed `(encodedUrl, exp)` pair via
 * `?sig=&exp=`. The frontend signs at the API boundary (see
 * frontend/src/lib/r2/sign-article-media.ts), so the worker doesn't need a
 * trusted-host allowlist. Unsigned requests are rejected with 403 — there is
 * no fallback. The signature is intentionally options-independent so Next.js
 * can request multiple widths from one stored URL.
 *
 * `env.IMAGES` is used over `cf.image` fetch options because the latter is
 * silently ignored on workers.dev domains. Every IMAGES call bills as a
 * transform, so transforms run through a two-tier cache:
 *   L1 — caches.default     (per-colo,  ~1-5ms,  ephemeral)
 *   L2 — env.IMAGE_CACHE R2 (global,    ~10-50ms, durable)
 * Only an L2 miss bills a transform. IMAGE_CACHE is a dedicated bucket so
 * its metrics and lifecycle rules stay isolated from env.R2 user uploads.
 *
 * URL fully determines the cached variant (width/quality in path, sha256
 * of upstream URL as key) — do not add Accept negotiation or a Vary
 * header, both will silently shard the cache.
 *
 * Cache key is intentionally NOT origin-bucketed (unlike /media/asset/ in
 * `r2-asset.ts`). That handler bucket-keys by Origin because its ACAO is
 * dynamic per allowlisted origin — without bucketing, a no-Origin populator
 * (curl, SSR) would poison the cache with an ACAO-less entry. Here ACAO is
 * always `*` (public image, signature is the real access control), so every
 * response is byte-identical regardless of Origin. No poisoning surface.
 *
 * Concurrent cold requests in different colos can each bill one transform
 * before either R2 write completes. Worst case is bounded by colo count
 * and accepted; a KV/DO single-flight lock isn't worth its own cost.
 *
 * Usage: GET /media/external/{options}/{mediaUrl}?sig={hex}&exp={unix}
 *   options — comma-separated key=value (w, q). Pass `passthrough` for raw.
 */

import type { Env, ExecutionContext } from '@shared/types';
import { getProxySigningSecret, verifyProxySignature } from './sign-url';

// Routing-only — these hosts serve byte-range video streams, so we always
// passthrough with Range forwarding regardless of request options. Not an
// auth check; the signature gate above already enforced access.
const VIDEO_HOSTS = new Set(['video.twimg.com']);
// Must stay in sync with frontend/next.config.ts images.deviceSizes/imageSizes.
// The options segment is intentionally unsigned so Next can choose a width at
// render time; this allowlist prevents leaked signed URLs from being used to
// mint arbitrary width/quality combinations and burn transformation quota.
const ALLOWED_TRANSFORM_WIDTHS = new Set([256, 1280, 1920]);
const ALLOWED_QUALITY = 75;
// Bumped when key derivation changes; old entries become orphaned and can
// be cleaned up via R2 lifecycle or `wrangler r2 object delete`.
const TRANSFORM_KEY_VERSION = 'v1';

type ParsedProxyOptions =
	| { kind: 'passthrough' }
	| {
			kind: 'transform';
			width: number;
			quality: number;
	  };

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
	return `${TRANSFORM_KEY_VERSION}/${hash}.webp`;
}

function transformedResponse(body: BodyInit | null, headersSource?: Headers): Response {
	const headers = new Headers(headersSource);
	headers.set('Access-Control-Allow-Origin', '*');
	headers.set('Content-Type', 'image/webp');
	headers.set('Cache-Control', 'public, max-age=31536000, immutable');
	return new Response(body, { status: 200, headers });
}

async function readR2CachedTransform(env: Env, key: string): Promise<Response | null> {
	const object = await env.IMAGE_CACHE.get(key);
	if (!object) return null;

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set('ETag', object.httpEtag);
	return transformedResponse(object.body, headers);
}

async function writeR2CachedTransform(env: Env, key: string, body: ArrayBuffer): Promise<void> {
	await env.IMAGE_CACHE.put(key, body, {
		httpMetadata: {
			contentType: 'image/webp',
			cacheControl: 'public, max-age=31536000, immutable',
		},
	});
}

export async function handleProxy(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (request.method === 'OPTIONS') return corsPreflight();

	const requestUrl = new URL(request.url);
	const match = requestUrl.pathname.match(/^\/media\/external\/([^/]+)\/(.+)$/);
	if (!match) return new Response('Expected: /media/external/{options}/{mediaUrl}', { status: 400 });

	const [, optionsStr, encodedUrl] = match;
	let parsed: URL;
	try {
		parsed = new URL(decodeURIComponent(encodedUrl));
	} catch {
		return new Response('Invalid media URL', { status: 400 });
	}
	if (parsed.protocol !== 'https:') return new Response('Only https upstreams allowed', { status: 403 });

	const signingSecret = getProxySigningSecret(env);
	if (!signingSecret) return new Response('Proxy signing not configured', { status: 503 });

	const sig = requestUrl.searchParams.get('sig');
	const exp = requestUrl.searchParams.get('exp');
	if (!sig || !exp) return new Response('Signature required', { status: 403 });

	const ok = await verifyProxySignature(encodedUrl, sig, exp, signingSecret);
	if (!ok) return new Response('Invalid or expired signature', { status: 403 });

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
		// Cold path only writes L2; the next same-colo request hits L2 and
		// promotes to L1 in the R2-hit branch. Skipping L1 here avoids paying
		// for two waitUntil tasks when the second eats the first ~5ms anyway.
		if (r2CacheKey) ctx.waitUntil(writeR2CachedTransform(env, r2CacheKey, body.slice(0)));
		return response;
	} catch (err) {
		console.error('Proxy error:', err);
		return new Response('Proxy error', {
			status: 502,
			headers: { 'Access-Control-Allow-Origin': '*' },
		});
	}
}
