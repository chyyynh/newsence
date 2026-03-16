// ─────────────────────────────────────────────────────────────
// URL Utilities
// ─────────────────────────────────────────────────────────────

/**
 * Resolves shortened URLs (t.co, bit.ly, etc.) to their final destination
 */
export async function resolveUrl(url: string): Promise<string> {
	try {
		const response = await fetch(url, {
			method: 'HEAD',
			redirect: 'follow',
		});
		return response.url;
	} catch {
		return url;
	}
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
		if (YOUTUBE_WATCH_HOSTS.has(hostname)) {
			if (urlObj.pathname === '/watch') {
				const videoId = urlObj.searchParams.get('v');
				if (videoId) return `https://youtube.com/watch?v=${videoId}`;
			}
			const pathMatch = urlObj.pathname.match(/^\/(embed|shorts|live)\/([a-zA-Z0-9_-]{11})/);
			if (pathMatch) return `https://youtube.com/watch?v=${pathMatch[2]}`;
		} else if (YOUTUBE_SHORT_HOSTS.has(hostname)) {
			const match = urlObj.pathname.match(/^\/([a-zA-Z0-9_-]{11})/);
			if (match) return `https://youtube.com/watch?v=${match[1]}`;
		}

		for (const param of TRACKING_PARAMS) urlObj.searchParams.delete(param);
		urlObj.searchParams.sort();
		return urlObj.toString();
	} catch {
		return url;
	}
}
