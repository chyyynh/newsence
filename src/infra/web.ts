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
];

/**
 * Normalizes URL by removing tracking, auth, and cache-busting parameters
 */
export function normalizeUrl(url: string): string {
	try {
		const urlObj = new URL(url);
		for (const param of TRACKING_PARAMS) urlObj.searchParams.delete(param);
		urlObj.searchParams.sort();
		return urlObj.toString();
	} catch {
		return url;
	}
}
