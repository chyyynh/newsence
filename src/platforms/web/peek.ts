import { BROWSER_UA } from '../../infra/fetch';

const PEEK_TIMEOUT_MS = 5_000;

export interface ContentTypePeek {
	contentType: string;
	contentLength: number | null;
	finalUrl: string;
}

/**
 * Cheaply discover an upstream URL's `Content-Type` before committing to scrape
 * it. Tries `HEAD` first (1 subrequest, ~0 bytes); if the origin doesn't honor
 * HEAD (405 / no content-type / opaque 200), falls back to a `Range: bytes=0-0`
 * GET that's immediately cancelled (still ~0 body bytes, headers only).
 *
 * Always returns — never throws — so callers can branch on the value. The
 * fallback `application/octet-stream` is what we use when we genuinely couldn't
 * learn anything about the origin.
 */
export async function peekContentType(url: string): Promise<ContentTypePeek> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), PEEK_TIMEOUT_MS);
	try {
		let res = await fetch(url, {
			method: 'HEAD',
			redirect: 'follow',
			signal: ctrl.signal,
			headers: { 'User-Agent': BROWSER_UA },
		}).catch(() => null);

		if (!res || !res.ok || !res.headers.get('content-type')) {
			res = await fetch(url, {
				redirect: 'follow',
				signal: ctrl.signal,
				headers: { 'User-Agent': BROWSER_UA, Range: 'bytes=0-0' },
			});
			// Free the subrequest immediately — we only care about headers.
			await res.body?.cancel();
		}

		const contentType = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? 'application/octet-stream';
		const lenRaw = res.headers.get('content-length');
		const contentLength = lenRaw ? Number.parseInt(lenRaw, 10) || null : null;
		return { contentType, contentLength, finalUrl: res.url || url };
	} finally {
		clearTimeout(timer);
	}
}

export function isHtmlLike(contentType: string): boolean {
	return contentType.includes('text/html') || contentType.includes('text/xml') || contentType.includes('application/xhtml');
}

export function isRasterImage(contentType: string): boolean {
	return contentType.startsWith('image/') && !contentType.startsWith('image/svg');
}
