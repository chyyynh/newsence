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
