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
