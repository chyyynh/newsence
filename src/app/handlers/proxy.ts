/**
 * Public media passthrough proxy with edge cache + Cloudflare Images binding.
 *
 * Read-only, no auth — the URL itself is the capability. Accepts any https URL:
 * Workers' fetch() natively blocks private/loopback/cloud-metadata IPs, so the
 * SSRF blast radius is "the public internet only." Image transforms go through
 * `env.IMAGES` (account-level binding) instead of `cf.image` fetch options
 * because the latter is silently ignored on workers.dev domains.
 *
 * Quota note: every `env.IMAGES.transform()` call counts toward the 5k/mo free
 * tier (URL-based cf.image dedupes by image+params, the binding does not). We
 * front the binding with the Workers Cache API keyed on
 * (request URL, negotiated format), so a transformed image is only billed
 * once per edge POP per cache lifetime.
 *
 * Usage: GET /proxy/{options}/{mediaUrl}
 *   options — comma-separated key=value (w, h, q). Pass `passthrough` for defaults.
 *
 * Video hosts skip transforms and propagate Range headers for seeking.
 */

import type { Env, ExecutionContext } from '../../models/types';

const VIDEO_HOSTS = new Set(['video.twimg.com']);

function isAllowedUrl(url: URL): boolean {
	return url.protocol === 'https:';
}

function parseOptions(optionsStr: string): Record<string, string> {
	const opts: Record<string, string> = {};
	for (const part of optionsStr.split(',')) {
		const idx = part.indexOf('=');
		if (idx > 0) opts[part.slice(0, idx)] = part.slice(idx + 1);
	}
	return opts;
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

function negotiateFormat(accept: string): 'image/avif' | 'image/webp' | 'image/jpeg' {
	if (accept.includes('image/avif')) return 'image/avif';
	if (accept.includes('image/webp')) return 'image/webp';
	return 'image/jpeg';
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

export async function handleProxy(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (request.method === 'OPTIONS') return corsPreflight();

	const { pathname } = new URL(request.url);
	const match = pathname.match(/^\/proxy\/([^/]+)\/(.+)$/);
	if (!match) return new Response('Expected: /proxy/{options}/{mediaUrl}', { status: 400 });

	const [, optionsStr, encodedUrl] = match;
	let parsed: URL;
	try {
		parsed = new URL(decodeURIComponent(encodedUrl));
	} catch {
		return new Response('Invalid media URL', { status: 400 });
	}
	if (!isAllowedUrl(parsed)) return new Response('URL not allowed', { status: 403 });

	try {
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

		const format = negotiateFormat(request.headers.get('Accept') || '');
		const cache = caches.default;
		const cacheUrl = new URL(request.url);
		cacheUrl.searchParams.set('_fmt', format.replace('image/', ''));
		const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
		const hit = await cache.match(cacheKey);
		if (hit) return hit;

		const upstream = await fetchUpstream(parsed, null);
		if (!upstream.ok || !upstream.body) {
			return new Response(`Upstream error: ${upstream.statusText}`, {
				status: upstream.status,
				headers: { 'Access-Control-Allow-Origin': '*' },
			});
		}

		const opts = parseOptions(optionsStr);
		const transform: ImageTransform = { fit: 'scale-down' };
		if (opts.w) transform.width = Number.parseInt(opts.w, 10);
		if (opts.h) transform.height = Number.parseInt(opts.h, 10);
		const quality = opts.q ? Number.parseInt(opts.q, 10) : 75;

		const result = await env.IMAGES.input(upstream.body).transform(transform).output({ format, quality });
		const base = result.response();
		const headers = new Headers(base.headers);
		headers.set('Access-Control-Allow-Origin', '*');
		headers.set('Cache-Control', 'public, max-age=31536000, immutable');
		headers.set('Vary', 'Accept');
		const response = new Response(base.body, { status: 200, headers });
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
