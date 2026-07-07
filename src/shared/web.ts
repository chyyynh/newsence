export const FEED_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
export const BROWSER_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const DEFAULT_TEXT_MAX_BYTES = 1024 * 1024;
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
	's',
	'ssr',
];

const DOMAIN_ALIASES: Record<string, string> = {
	'twitter.com': 'x.com',
	'www.twitter.com': 'x.com',
	'mobile.twitter.com': 'x.com',
	'www.x.com': 'x.com',
};
const HACKERNEWS_HOSTS = new Set(['news.ycombinator.com', 'ycombinator.com']);
const SOCIAL_MEDIA_HOSTS = new Set(['twitter.com', 'x.com', 'instagram.com', 'tiktok.com', 'facebook.com', 'threads.net']);
const TWITTER_HOSTS = new Set(['twitter.com', 'x.com']);
const YOUTUBE_WATCH_HOSTS = new Set(['youtube.com', 'm.youtube.com']);
const YOUTUBE_SHORT_HOSTS = new Set(['youtu.be']);

export type UrlKind = 'hackernews' | 'youtube' | 'twitter' | 'web';

export class PayloadTooLargeError extends Error {
	constructor(maxBytes: number) {
		super(`Response body exceeded ${maxBytes} bytes`);
		this.name = 'PayloadTooLargeError';
	}
}

function timeoutSignal(options: RequestInit, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}

function isTimeoutError(err: unknown): boolean {
	return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

function hostMatches(hostname: string, hosts: ReadonlySet<string>): boolean {
	if (hosts.has(hostname)) return true;
	for (const host of hosts) {
		if (hostname.endsWith(`.${host}`)) return true;
	}
	return false;
}

function canonicalHost(hostname: string): string {
	const lower = hostname.toLowerCase();
	return DOMAIN_ALIASES[lower] ?? (lower.startsWith('www.') ? lower.slice(4) : lower);
}

function isYouTubeHost(hostname: string): boolean {
	return hostMatches(hostname, YOUTUBE_WATCH_HOSTS) || hostMatches(hostname, YOUTUBE_SHORT_HOSTS);
}

function parseUrl(rawUrl: string): URL | null {
	try {
		return new URL(rawUrl);
	} catch {
		return null;
	}
}

export async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
	try {
		return await fetch(url, { ...options, signal: timeoutSignal(options, timeoutMs) });
	} catch (err) {
		if (isTimeoutError(err)) throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
		throw err;
	}
}

export async function readTextWithLimit(response: Response, maxBytes = DEFAULT_TEXT_MAX_BYTES): Promise<string> {
	const contentLength = Number.parseInt(response.headers.get('content-length') || '0', 10);
	if (contentLength > maxBytes) throw new Error(`Response too large: ${contentLength} bytes`);
	if (!response.body) return '';

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = '';
	let totalBytes = 0;

	for (;;) {
		const { done, value } = await reader.read();
		if (done) return text + decoder.decode();

		totalBytes += value.byteLength;
		if (totalBytes > maxBytes) {
			await reader.cancel();
			throw new Error(`Response body exceeded ${maxBytes} bytes`);
		}
		text += decoder.decode(value, { stream: true });
	}
}

export async function fetchJsonWithTimeout<T>(
	url: string,
	options: RequestInit = {},
	timeoutMs = 15_000,
	maxBytes = DEFAULT_TEXT_MAX_BYTES,
): Promise<T> {
	const response = await fetchWithTimeout(url, options, timeoutMs);
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`HTTP ${response.status}: ${response.statusText}`);
	}
	return JSON.parse(await readTextWithLimit(response, maxBytes)) as T;
}

export function streamWithByteLimit(
	body: ReadableStream<Uint8Array>,
	maxBytes: number,
): { stream: ReadableStream<Uint8Array>; getBytesSeen: () => number } {
	let bytesSeen = 0;
	const stream = body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				bytesSeen += chunk.byteLength;
				if (bytesSeen > maxBytes) {
					controller.error(new PayloadTooLargeError(maxBytes));
					return;
				}
				controller.enqueue(chunk);
			},
		}),
	);
	return { stream, getBytesSeen: () => bytesSeen };
}

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

export async function validateImageUrl(url: string | null | undefined, timeoutMs = 5_000): Promise<string | null> {
	const trimmed = url?.trim();
	if (!trimmed) return null;

	const init: RequestInit = {
		redirect: 'follow',
		headers: { 'User-Agent': BROWSER_UA },
	};
	try {
		let res = await fetchWithTimeout(trimmed, { ...init, method: 'HEAD' }, timeoutMs);
		if (res.status === 405 || res.status === 501) {
			res = await fetchWithTimeout(trimmed, { ...init, method: 'GET', headers: { ...init.headers, Range: 'bytes=0-0' } }, timeoutMs);
		}
		await res.body?.cancel();

		if (!res.ok) return null;
		const contentType = res.headers.get('content-type')?.toLowerCase() ?? '';
		return !contentType || contentType.startsWith('image/') ? trimmed : null;
	} catch {
		return null;
	}
}

export function assertExternalFetchable(rawUrl: string): URL {
	const parsed = parseUrl(rawUrl);
	if (!parsed) throw new Error('Invalid URL');
	if (parsed.protocol !== 'https:') throw new Error('Only https:// URLs are allowed');
	if (parsed.username || parsed.password) throw new Error('URL must not include credentials');
	return parsed;
}

export function isSocialMediaUrl(url: string): boolean {
	const parsed = parseUrl(url);
	return parsed ? hostMatches(canonicalHost(parsed.hostname), SOCIAL_MEDIA_HOSTS) : false;
}

export function normalizeUrl(url: string): string {
	const parsed = parseUrl(url);
	if (!parsed) return url;

	parsed.hostname = canonicalHost(parsed.hostname);
	if (isYouTubeHost(parsed.hostname)) {
		const videoId = extractYouTubeId(parsed.toString());
		if (videoId) return `https://youtube.com/watch?v=${videoId}`;
	}

	for (const param of TRACKING_PARAMS) parsed.searchParams.delete(param);
	parsed.searchParams.sort();
	return parsed.toString();
}

export function detectUrlKind(url: string): UrlKind {
	const parsed = parseUrl(url);
	if (!parsed) return 'web';

	const hostname = canonicalHost(parsed.hostname);
	if (hostMatches(hostname, HACKERNEWS_HOSTS)) return 'hackernews';
	if (isYouTubeHost(hostname)) return 'youtube';
	if (hostMatches(hostname, TWITTER_HOSTS)) return 'twitter';
	return 'web';
}

export function extractTweetId(url: string): string | null {
	const parsed = parseUrl(url);
	if (!parsed || !hostMatches(canonicalHost(parsed.hostname), TWITTER_HOSTS)) return null;
	return parsed.pathname.match(/^\/[^/]+\/status\/(\d+)/)?.[1] ?? null;
}

export function extractYouTubeId(url: string): string | null {
	const parsed = parseUrl(url);
	if (!parsed) return null;

	const watchId = parsed.searchParams.get('v');
	if (watchId?.match(/^[a-zA-Z0-9_-]{11}$/)) return watchId;

	const parts = parsed.pathname.split('/').filter(Boolean);
	if (hostMatches(canonicalHost(parsed.hostname), YOUTUBE_SHORT_HOSTS)) return parts[0]?.match(/^[a-zA-Z0-9_-]{11}$/)?.[0] ?? null;
	if (['embed', 'shorts', 'live', 'v'].includes(parts[0] ?? '')) return parts[1]?.match(/^[a-zA-Z0-9_-]{11}$/)?.[0] ?? null;
	return null;
}

export function extractHackerNewsId(url: string): string | null {
	const id = parseUrl(url)?.searchParams.get('id');
	return id?.match(/^\d+$/)?.[0] ?? null;
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

export function htmlToText(str: string): string {
	return decodeHtmlEntities(str.replace(/<[^>]*>/g, ' '))
		.replace(/\s+/g, ' ')
		.trim();
}
