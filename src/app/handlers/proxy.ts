/**
 * Public media passthrough proxy with edge cache + Cloudflare Image Resizing.
 *
 * Read-only, no auth — the URL itself is the capability. Hosts are restricted
 * to a small allowlist so the worker can't be turned into an open relay.
 *
 * Usage: GET /proxy/{options}/{mediaUrl}
 *   options — comma-separated key=value (w, h, q). Pass `passthrough` for defaults.
 *
 * Video hosts skip Image Resizing and propagate Range headers for seeking.
 */

import type { Env } from '../../models/types';

const ALLOWED_HOSTS = new Set([
	'pbs.twimg.com',
	'video.twimg.com',
	'abs.twimg.com',
	'i.ytimg.com',
	'yt3.ggpht.com',
	'cdn.openai.com',
	'substackcdn.com',
]);

const VIDEO_HOSTS = new Set(['video.twimg.com']);

function isAllowedUrl(url: URL): boolean {
	if (url.protocol !== 'https:') return false;
	return ALLOWED_HOSTS.has(url.hostname);
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

export async function handleProxy(request: Request, _env: Env): Promise<Response> {
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

	const fetchHeaders: HeadersInit = {
		'User-Agent': 'Mozilla/5.0 (compatible; NewsenceProxy/1.0)',
	};
	const rangeHeader = request.headers.get('Range');
	if (rangeHeader) fetchHeaders.Range = rangeHeader;

	const isVideo = VIDEO_HOSTS.has(parsed.hostname);
	const fetchOpts: RequestInit & { cf?: Record<string, unknown> } = {
		headers: fetchHeaders,
		cf: {
			cacheEverything: true,
			cacheTtl: 60 * 60 * 24 * 30,
		},
	};

	if (!isVideo) {
		const opts = parseOptions(optionsStr);
		// Workers must negotiate format manually — `format=auto` is URL-only.
		const accept = request.headers.get('Accept') || '';
		let format: string = 'jpeg';
		if (accept.includes('image/avif')) format = 'avif';
		else if (accept.includes('image/webp')) format = 'webp';

		const imageOpts: Record<string, unknown> = {
			format,
			metadata: 'none',
			fit: 'scale-down',
			quality: opts.q ? Number.parseInt(opts.q, 10) : 75,
		};
		if (opts.w) imageOpts.width = Number.parseInt(opts.w, 10);
		if (opts.h) imageOpts.height = Number.parseInt(opts.h, 10);
		fetchOpts.cf!.image = imageOpts;
	}

	try {
		const upstream = await fetch(parsed.toString(), fetchOpts);
		if (!upstream.ok && upstream.status !== 206) {
			return new Response(`Upstream error: ${upstream.statusText}`, {
				status: upstream.status,
				headers: { 'Access-Control-Allow-Origin': '*' },
			});
		}

		const headers = new Headers();
		headers.set('Access-Control-Allow-Origin', '*');
		headers.set('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
		headers.set('Cache-Control', isVideo ? 'public, max-age=604800' : 'public, max-age=31536000, immutable');
		for (const key of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']) {
			const value = upstream.headers.get(key);
			if (value) headers.set(key, value);
		}

		return new Response(upstream.body, { status: upstream.status, headers });
	} catch (err) {
		console.error('Proxy error:', err);
		return new Response('Proxy error', {
			status: 502,
			headers: { 'Access-Control-Allow-Origin': '*' },
		});
	}
}
