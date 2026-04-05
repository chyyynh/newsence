// ─────────────────────────────────────────────────────────────
// YouTube Platform Metadata Types + Builders
// ─────────────────────────────────────────────────────────────

function now(): string {
	return new Date().toISOString();
}

export interface YouTubeMetadata {
	videoId: string;
	channelName: string;
	channelId?: string;
	channelAvatar?: string;
	duration?: string;
	thumbnailUrl?: string;
	viewCount?: number;
	likeCount?: number;
	commentCount?: number;
	publishedAt?: string;
	description?: string;
	tags?: string[];
}

// ─────────────────────────────────────────────────────────────
// Builders
// ─────────────────────────────────────────────────────────────

export function buildYouTube(data: YouTubeMetadata): { type: 'youtube'; fetchedAt: string; data: YouTubeMetadata } {
	return {
		type: 'youtube',
		fetchedAt: now(),
		data,
	};
}
