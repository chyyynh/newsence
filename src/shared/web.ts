// ─────────────────────────────────────────────────────────────
// Fetch / URL Utilities
// ─────────────────────────────────────────────────────────────

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

const DEFAULT_TEXT_MAX_BYTES = 1024 * 1024;

export async function readTextWithLimit(response: Response, maxBytes = DEFAULT_TEXT_MAX_BYTES): Promise<string> {
	const contentLength = Number(response.headers.get('content-length') || '0');
	if (contentLength > maxBytes) throw new Error(`Response too large: ${contentLength} bytes`);
	if (!response.body) return '';

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = '';
	let totalBytes = 0;

	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			text += decoder.decode();
			break;
		}
		totalBytes += value.byteLength;
		if (totalBytes > maxBytes) {
			await reader.cancel();
			throw new Error(`Response body exceeded ${maxBytes} bytes`);
		}
		text += decoder.decode(value, { stream: true });
	}

	return text;
}

export async function fetchJsonWithTimeout<T>(
	url: string,
	options: RequestInit = {},
	timeoutMs = 15_000,
	maxBytes = DEFAULT_TEXT_MAX_BYTES,
): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { ...options, signal: controller.signal });
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}
		const text = await readTextWithLimit(response, maxBytes);
		return JSON.parse(text) as T;
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
 * Resolves shortened URLs (t.co, bit.ly, etc.) to their final destination
 */
export async function resolveUrl(url: string): Promise<string> {
	try {
		const response = await fetchWithTimeout(url, {
			method: 'HEAD',
			redirect: 'follow',
			headers: { 'User-Agent': BROWSER_UA },
		});
		return response.url;
	} catch {
		return url;
	}
}

/**
 * Liveness check for a scraped image URL — returns the trimmed URL if the
 * origin responds 2xx with an image content-type, else null. Used at ingest
 * to drop og:image URLs that 404 / point at non-images.
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

/**
 * Gate for user-submitted URLs that the worker will fetch. CF runtime already
 * blocks private/loopback IPs and DNS rebinding — this catches the input-shape
 * issues the runtime doesn't: plaintext HTTP (token leakage via MITM) and
 * embedded credentials (`https://user:pass@host`, which leak via logs and
 * Referer). Throws on rejection so callers handle via existing try/catch.
 */
export function assertExternalFetchable(rawUrl: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new Error('Invalid URL');
	}
	if (parsed.protocol !== 'https:') throw new Error('Only https:// URLs are allowed');
	if (parsed.username || parsed.password) throw new Error('URL must not include credentials');
	return parsed;
}

/**
 * Checks if a URL is a social media link (should not follow)
 */
export function isSocialMediaUrl(url: string): boolean {
	const socialDomains = ['twitter.com', 'x.com', 'instagram.com', 'tiktok.com', 'facebook.com', 'threads.net'];
	try {
		const hostname = new URL(url).hostname.toLowerCase();
		return socialDomains.some((d) => hostname.includes(d));
	} catch {
		return false;
	}
}

// ─────────────────────────────────────────────────────────────
// URL Normalization
// ─────────────────────────────────────────────────────────────

const TRACKING_PARAMS = [
	'utm_source',
	'utm_medium',
	'utm_campaign',
	'utm_content',
	'utm_term',
	'ref',
	'fbclid',
	'gclid',
	'mc_eid',
	'mc_cid',
	'access_token',
	'token',
	'auth_token',
	'api_key',
	'_',
	'__',
	'nc',
	'cachebust',
	'noCache',
	'cache',
	'rand',
	'random',
	'_rnd',
	'_refresh',
	'_t',
	'_ts',
	'_dc',
	'_q',
	'_nocache',
	'timestamp',
	'ts',
	'time',
	'cb',
	'r',
	'sid',
	'ttl',
	'vfff',
	'ttt',
	'triedRedirect',
	's', // Twitter share tracking
	'ssr',
];

/** Domain aliases that should be normalized to a canonical form */
const DOMAIN_ALIASES: Record<string, string> = {
	'twitter.com': 'x.com',
	'www.twitter.com': 'x.com',
	'mobile.twitter.com': 'x.com',
	'www.x.com': 'x.com',
};

/** YouTube hostnames that use ?v= parameter */
export const YOUTUBE_WATCH_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
/** YouTube shortlink hosts that use path-based video ID */
export const YOUTUBE_SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be']);

export function buildYouTubeWatchUrl(videoId: string): string {
	return `https://youtube.com/watch?v=${videoId}`;
}

/**
 * Normalizes URL by:
 * 1. Canonicalizing domain aliases (twitter.com → x.com, etc.)
 * 2. Stripping www. prefix
 * 3. Removing tracking, auth, and cache-busting parameters
 * 4. YouTube: canonicalize to youtube.com/watch?v=VIDEO_ID
 */
export function normalizeUrl(url: string): string {
	try {
		const urlObj = new URL(url);

		// Normalize domain aliases
		const hostname = urlObj.hostname.toLowerCase();
		const canonical = DOMAIN_ALIASES[hostname];
		if (canonical) {
			urlObj.hostname = canonical;
		} else if (hostname.startsWith('www.')) {
			urlObj.hostname = hostname.slice(4);
		}

		// YouTube → canonical youtube.com/watch?v=VIDEO_ID
		if (YOUTUBE_WATCH_HOSTS.has(hostname) || YOUTUBE_SHORT_HOSTS.has(hostname)) {
			const videoId = extractYouTubeId(urlObj.toString());
			if (videoId) return buildYouTubeWatchUrl(videoId);
		}

		for (const param of TRACKING_PARAMS) urlObj.searchParams.delete(param);
		urlObj.searchParams.sort();
		return urlObj.toString();
	} catch {
		return url;
	}
}

export interface TranscriptSegment {
	startTime: number;
	endTime: number;
	text: string;
}

export interface YouTubeChapter {
	title: string;
	startTime: number;
	endTime: number;
}

export interface ScrapedContent {
	title: string;
	content: string;
	summary?: string;
	ogImageUrl: string | null;
	ogImageWidth?: number | null;
	ogImageHeight?: number | null;
	siteName: string | null;
	author: string | null;
	publishedDate: string | null;
	metadata?: Record<string, unknown>;
	youtubeTranscript?: {
		videoId: string;
		segments: TranscriptSegment[];
		language: string | null;
		chapters: YouTubeChapter[];
		chaptersFromDescription: boolean;
	};
}

export type PlatformType = 'hackernews' | 'youtube' | 'twitter' | 'web';

const HACKERNEWS_HOSTS = new Set(['news.ycombinator.com', 'ycombinator.com', 'www.ycombinator.com']);
const TWITTER_HOSTS = new Set(['twitter.com', 'x.com', 'www.twitter.com', 'www.x.com', 'mobile.twitter.com']);

export function detectPlatformType(url: string): PlatformType {
	try {
		const hostname = new URL(url).hostname.toLowerCase();
		if (HACKERNEWS_HOSTS.has(hostname)) return 'hackernews';
		if (YOUTUBE_WATCH_HOSTS.has(hostname) || YOUTUBE_SHORT_HOSTS.has(hostname)) return 'youtube';
		if (TWITTER_HOSTS.has(hostname)) return 'twitter';
		return 'web';
	} catch {
		return 'web';
	}
}

export function extractTweetId(url: string): string | null {
	const match = url.match(/(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/);
	return match?.[1] ?? null;
}

export function extractYouTubeId(url: string): string | null {
	const patterns = [
		/[?&]v=([a-zA-Z0-9_-]{11})/,
		/youtu\.be\/([a-zA-Z0-9_-]{11})/,
		/\/embed\/([a-zA-Z0-9_-]{11})/,
		/\/shorts\/([a-zA-Z0-9_-]{11})/,
		/\/live\/([a-zA-Z0-9_-]{11})/,
		/\/v\/([a-zA-Z0-9_-]{11})/,
	];
	for (const pattern of patterns) {
		const match = url.match(pattern);
		if (match) return match[1];
	}
	return null;
}

export function extractHackerNewsId(url: string): string | null {
	const match = url.match(/[?&]id=(\d+)/);
	return match?.[1] ?? null;
}

export function decodeHtmlEntities(str: string): string {
	return str
		.replace(/&quot;/g, '"')
		.replace(/&#x27;|&#39;/g, "'")
		.replace(/&#x2F;/g, '/')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&');
}

function stripHtmlTags(str: string): string {
	return str.replace(/<[^>]*>/g, ' ');
}

export function htmlToText(str: string): string {
	return decodeHtmlEntities(stripHtmlTags(str)).replace(/\s+/g, ' ').trim();
}
