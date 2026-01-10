export type PlatformType = 'hackernews' | 'youtube' | 'twitter' | 'web';

const HACKERNEWS_HOSTS = new Set(['news.ycombinator.com', 'ycombinator.com', 'www.ycombinator.com']);
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be']);
const TWITTER_HOSTS = new Set(['twitter.com', 'x.com', 'www.twitter.com', 'www.x.com', 'mobile.twitter.com']);

export function detectPlatformType(url: string): PlatformType {
	try {
		const hostname = new URL(url).hostname.toLowerCase();

		if (HACKERNEWS_HOSTS.has(hostname)) return 'hackernews';
		if (YOUTUBE_HOSTS.has(hostname)) return 'youtube';
		if (TWITTER_HOSTS.has(hostname)) return 'twitter';

		return 'web';
	} catch {
		return 'web';
	}
}

export function extractHnItemId(url: string): string | null {
	const match = url.match(/[?&]id=(\d+)/);
	return match?.[1] ?? null;
}

const YOUTUBE_PATTERNS = [
	/[?&]v=([a-zA-Z0-9_-]+)/,      // youtube.com/watch?v=VIDEO_ID
	/youtu\.be\/([a-zA-Z0-9_-]+)/, // youtu.be/VIDEO_ID
	/\/embed\/([a-zA-Z0-9_-]+)/,   // youtube.com/embed/VIDEO_ID
	/\/shorts\/([a-zA-Z0-9_-]+)/,  // youtube.com/shorts/VIDEO_ID
];

export function extractYouTubeVideoId(url: string): string | null {
	for (const pattern of YOUTUBE_PATTERNS) {
		const match = url.match(pattern);
		if (match) return match[1];
	}
	return null;
}

export function extractTweetId(url: string): string | null {
	const match = url.match(/(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/);
	return match?.[1] ?? null;
}
