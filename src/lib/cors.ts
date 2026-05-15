/**
 * CORS allowlist for /media/asset/* responses.
 *
 * The HMAC signature on each asset URL is the real access control. This helper
 * adds defense-in-depth so that if a signed URL leaks (extension, screenshot
 * OCR, etc.), a third-party origin's JS can't `fetch()` the bytes and read the
 * response body. <img src> rendering is unaffected — CORS doesn't gate it.
 *
 * `APP_ORIGINS` is comma-separated (`https://newsence.app,http://localhost:3000`).
 * If unset, we log once and fall back to `*` (matches IMAGE_PROXY_SECRET's
 * legacy-fallback philosophy in sign-url.ts).
 */

import type { Env } from '../models/types';

let unsetWarningLogged = false;

function parseAllowlist(env: Env): string[] | null {
	const list = env.APP_ORIGINS?.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	return list?.length ? list : null;
}

function warnAllowlistUnset(): void {
	if (unsetWarningLogged) return;
	console.warn(JSON.stringify({ message: 'APP_ORIGINS unset, media asset CORS falls back to *' }));
	unsetWarningLogged = true;
}

export function getCorsHeaders(request: Request, env: Env): Record<string, string> {
	const allowlist = parseAllowlist(env);
	if (!allowlist) {
		warnAllowlistUnset();
		return { 'Access-Control-Allow-Origin': '*' };
	}

	const origin = request.headers.get('Origin');
	if (origin && allowlist.includes(origin)) {
		return {
			'Access-Control-Allow-Origin': origin,
			Vary: 'Origin',
		};
	}

	// Cross-origin from a non-allowlisted origin, or no Origin header at all
	// (same-origin / non-browser). Omit ACAO so cross-origin JS gets a CORS
	// error when reading the response. Vary is a hint to downstream/browser
	// caches; `caches.default` ignores it (only Vary: Accept-Encoding is honored
	// per Cloudflare docs), which is why callers must also bucket the cache key
	// via `getOriginCacheBucket` below.
	return { Vary: 'Origin' };
}

/**
 * Cache-key dimension for `caches.default`. Because Workers' Cache API does not
 * honor `Vary: Origin`, two callers from different Origins would otherwise
 * share one entry — and a no-Origin populator (curl, SSR fetch, some <img>
 * requests) could poison the cache with an ACAO-less response that breaks
 * subsequent allowlisted-origin `fetch()` calls.
 *
 * Bucket scheme keeps cardinality bounded at N+3 (one per allowlisted origin,
 * 'no-origin' for same-origin / non-browser, 'denied' for non-allowlisted
 * cross-origin, 'fallback' when APP_ORIGINS is unset and we serve `ACAO: *`).
 *
 * 'no-origin' and 'denied' are kept distinct even though `getCorsHeaders`
 * currently produces byte-identical responses for both: if a future change ever
 * varies the response (e.g. echoing extra headers only for denied requests),
 * the buckets enforce the invariant rather than rely on it. 'denied' does not
 * include the actual Origin value — that'd let any caller blow up cache
 * cardinality by sending arbitrary Origin headers.
 */
export function getOriginCacheBucket(request: Request, env: Env): string {
	const allowlist = parseAllowlist(env);
	if (!allowlist) return 'fallback';
	const origin = request.headers.get('Origin');
	if (!origin) return 'no-origin';
	return allowlist.includes(origin) ? `allow:${origin}` : 'denied';
}
