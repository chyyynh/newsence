/**
 * Detects if URL is Twitter/X or regular web
 */
export function detectUrlType(url: string): 'twitter' | 'web' {
	try {
		const urlObj = new URL(url);
		const hostname = urlObj.hostname.toLowerCase();

		if (
			hostname === 'twitter.com' ||
			hostname === 'x.com' ||
			hostname === 'www.twitter.com' ||
			hostname === 'www.x.com' ||
			hostname === 'mobile.twitter.com'
		) {
			return 'twitter';
		}

		return 'web';
	} catch {
		return 'web';
	}
}

/**
 * Extracts tweet ID from Twitter URL
 */
export function extractTweetId(url: string): string | null {
	const match = url.match(/(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/);
	return match ? match[1] : null;
}

/**
 * Normalizes URL by removing tracking parameters
 */
export function normalizeUrl(url: string): string {
	try {
		const urlObj = new URL(url);

		const paramsToRemove = [
			'utm_source',
			'utm_medium',
			'utm_campaign',
			'utm_content',
			'utm_term',
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
			'ref',
			'source',
			's', // Twitter share tracking
		];

		paramsToRemove.forEach((param) => {
			urlObj.searchParams.delete(param);
		});

		return urlObj.toString();
	} catch {
		return url;
	}
}

/**
 * Validates URL format
 */
export function isValidUrl(url: string): boolean {
	try {
		const urlObj = new URL(url);
		return urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
	} catch {
		return false;
	}
}
