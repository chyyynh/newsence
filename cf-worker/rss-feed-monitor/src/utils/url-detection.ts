/**
 * URL Detection Utilities
 * Detects platform type and extracts IDs from URLs
 */

export type PlatformType = 'hackernews' | 'youtube' | 'twitter' | 'web';

/**
 * Detects platform type from URL
 */
export function detectPlatformType(url: string): PlatformType {
	try {
		const hostname = new URL(url).hostname.toLowerCase();

		// HackerNews
		if (
			hostname === 'news.ycombinator.com' ||
			hostname === 'ycombinator.com' ||
			hostname === 'www.ycombinator.com'
		) {
			return 'hackernews';
		}

		// YouTube
		if (
			hostname === 'youtube.com' ||
			hostname === 'www.youtube.com' ||
			hostname === 'm.youtube.com' ||
			hostname === 'youtu.be' ||
			hostname === 'www.youtu.be'
		) {
			return 'youtube';
		}

		// Twitter/X
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
 * Extracts HackerNews item ID from URL
 */
export function extractHnItemId(url: string): string | null {
	const match = url.match(/[?&]id=(\d+)/);
	return match ? match[1] : null;
}

/**
 * Extracts YouTube video ID from URL
 */
export function extractYouTubeVideoId(url: string): string | null {
	// youtube.com/watch?v=VIDEO_ID
	let match = url.match(/[?&]v=([a-zA-Z0-9_-]+)/);
	if (match) return match[1];

	// youtu.be/VIDEO_ID
	match = url.match(/youtu\.be\/([a-zA-Z0-9_-]+)/);
	if (match) return match[1];

	// youtube.com/embed/VIDEO_ID
	match = url.match(/\/embed\/([a-zA-Z0-9_-]+)/);
	if (match) return match[1];

	// youtube.com/shorts/VIDEO_ID
	match = url.match(/\/shorts\/([a-zA-Z0-9_-]+)/);
	if (match) return match[1];

	return null;
}

/**
 * Extracts Twitter tweet ID from URL
 */
export function extractTweetId(url: string): string | null {
	const match = url.match(/(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/);
	return match ? match[1] : null;
}
