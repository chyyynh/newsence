const TRACKING_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'mc_eid', 'mc_cid'];

const DOMAIN_ALIASES: Record<string, string> = {
	'twitter.com': 'x.com',
	'www.twitter.com': 'x.com',
	'mobile.twitter.com': 'x.com',
	'www.x.com': 'x.com',
};
const YOUTUBE_WATCH_HOSTS = new Set(['youtube.com', 'm.youtube.com']);
const YOUTUBE_SHORT_HOSTS = new Set(['youtu.be']);
const YOUTUBE_VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const PREVIEW_IMAGE_TARGET_WIDTH = 1200;
const WORDPRESS_UPLOAD_PATH = /\/wp-content\/uploads\//i;

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

function positiveInteger(value: string | null): number | null {
	if (!value || !/^\d+$/.test(value)) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Upgrade undersized WordPress feed/extractor thumbnails before they become
 * durable resource metadata. Width-only delivery preserves the source aspect
 * ratio and avoids rehosting a 150 px crop for a full-width card.
 */
export function normalizePreviewImageUrl(value: string, baseUrl?: string): string | null {
	let parsed: URL | null;
	try {
		parsed = parseUrl(baseUrl ? new URL(value, baseUrl).toString() : value);
	} catch {
		return null;
	}
	if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return null;
	if (!WORDPRESS_UPLOAD_PATH.test(parsed.pathname)) return parsed.toString();

	const width = positiveInteger(parsed.searchParams.get('w'));
	const resizeWidth = positiveInteger(parsed.searchParams.get('resize')?.split(',')[0] ?? null);
	if ((width ?? resizeWidth ?? PREVIEW_IMAGE_TARGET_WIDTH) >= PREVIEW_IMAGE_TARGET_WIDTH) return parsed.toString();

	parsed.searchParams.set('w', String(PREVIEW_IMAGE_TARGET_WIDTH));
	for (const parameter of ['crop', 'h', 'height', 'resize']) parsed.searchParams.delete(parameter);
	return parsed.toString();
}

export function extractYouTubeId(url: string): string | null {
	const parsed = parseUrl(url);
	if (!parsed) return null;
	const hostname = canonicalHost(parsed.hostname);
	if (!isYouTubeHost(hostname)) return null;

	const watchId = parsed.searchParams.get('v');
	if (watchId?.match(YOUTUBE_VIDEO_ID_RE)) return watchId;

	const [kind, maybeId] = parsed.pathname.split('/').filter(Boolean);
	const pathId = hostMatches(hostname, YOUTUBE_SHORT_HOSTS) ? kind : ['embed', 'shorts', 'live', 'v'].includes(kind ?? '') ? maybeId : null;
	return pathId?.match(YOUTUBE_VIDEO_ID_RE)?.[0] ?? null;
}
