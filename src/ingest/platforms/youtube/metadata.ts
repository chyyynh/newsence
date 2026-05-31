// ─────────────────────────────────────────────────────────────
// YouTube Platform Metadata Types + Builders
// ─────────────────────────────────────────────────────────────

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
		fetchedAt: new Date().toISOString(),
		data,
	};
}
