/**
 * CORS allowlist for /r2/* responses.
 *
 * The HMAC signature on each /r2 URL is the real access control. This helper
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

export function getCorsHeaders(request: Request, env: Env): Record<string, string> {
	const allowlist = env.APP_ORIGINS?.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

	if (!allowlist?.length) {
		if (!unsetWarningLogged) {
			console.warn(JSON.stringify({ message: 'APP_ORIGINS unset, /r2 CORS falls back to *' }));
			unsetWarningLogged = true;
		}
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
	// error when reading the response. Vary still keeps the edge cache honest.
	return { Vary: 'Origin' };
}
