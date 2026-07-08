export const FEED_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

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
const YOUTUBE_WATCH_HOSTS = new Set(['youtube.com', 'm.youtube.com']);
const YOUTUBE_SHORT_HOSTS = new Set(['youtu.be']);
const YOUTUBE_VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

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
		const timeout = AbortSignal.timeout(timeoutMs);
		return await fetch(url, { ...options, signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout });
	} catch (err) {
		if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
			throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
		}
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

export async function readBytesWithLimit(response: Response, maxBytes: number): Promise<Uint8Array> {
	const contentLength = Number.parseInt(response.headers.get('content-length') || '0', 10);
	if (contentLength > maxBytes) throw new Error(`Response too large: ${contentLength} bytes`);
	if (!response.body) return new Uint8Array();

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			const bytes = new Uint8Array(totalBytes);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.byteLength;
			}
			return bytes;
		}

		totalBytes += value.byteLength;
		if (totalBytes > maxBytes) {
			await reader.cancel();
			throw new Error(`Response body exceeded ${maxBytes} bytes`);
		}
		chunks.push(value);
	}
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

export function extractYouTubeId(url: string): string | null {
	const parsed = parseUrl(url);
	if (!parsed) return null;

	const watchId = parsed.searchParams.get('v');
	if (watchId?.match(YOUTUBE_VIDEO_ID_RE)) return watchId;

	const [kind, maybeId] = parsed.pathname.split('/').filter(Boolean);
	const pathId = hostMatches(canonicalHost(parsed.hostname), YOUTUBE_SHORT_HOSTS)
		? kind
		: ['embed', 'shorts', 'live', 'v'].includes(kind ?? '')
			? maybeId
			: null;
	return pathId?.match(YOUTUBE_VIDEO_ID_RE)?.[0] ?? null;
}
