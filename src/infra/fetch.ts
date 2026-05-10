// User-Agent strings for outbound fetches. Two flavors are kept on purpose:
// FEED_UA is short enough that boring XML/Atom endpoints (RSS, YouTube
// channel feeds) accept it without triggering bot heuristics; BROWSER_UA
// looks like a real Chrome session and is the one to use when hitting
// arbitrary HTML pages that often sit behind Cloudflare or similar.
export const FEED_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
export const BROWSER_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * `fetch` wrapped with an AbortController so a stalled origin can't hang a
 * cron invocation until the Worker's own runtime timeout. All cron-path
 * outbound HTTP should go through this helper.
 */
export async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...options, signal: controller.signal });
	} catch (err) {
		if (err instanceof Error && err.name === 'AbortError') {
			throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Liveness check for a scraped image URL — returns the trimmed URL if the
 * origin responds 2xx with an image content-type, else null. Used at ingest
 * to drop og:image URLs that 404 / point at non-images, so the frontend
 * never has to flicker an empty placeholder.
 *
 * HEAD first; falls back to ranged GET on 405/501 since some CDNs reject
 * HEAD. Network/abort errors all collapse to null — we'd rather lose a real
 * image once than ship a broken one.
 */
export async function validateImageUrl(url: string | null | undefined, timeoutMs = 5_000): Promise<string | null> {
	if (!url) return null;
	const trimmed = url.trim();
	if (!trimmed) return null;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const init: RequestInit = {
		signal: controller.signal,
		redirect: 'follow',
		headers: { 'User-Agent': BROWSER_UA },
	};
	try {
		let res = await fetch(trimmed, { ...init, method: 'HEAD' });
		if (res.status === 405 || res.status === 501) {
			res = await fetch(trimmed, { ...init, method: 'GET', headers: { ...init.headers, Range: 'bytes=0-0' } });
		}
		if (!res.ok) return null;
		const ct = res.headers.get('content-type') ?? '';
		if (ct && !ct.toLowerCase().startsWith('image/')) return null;
		return trimmed;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}
