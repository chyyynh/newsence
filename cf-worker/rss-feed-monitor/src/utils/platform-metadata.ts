/**
 * Platform Metadata Utilities
 * Fetches platform-specific metadata for HackerNews and YouTube
 */

import { detectPlatformType, extractHnItemId, extractYouTubeVideoId } from './url-detection';

const HN_ALGOLIA_API = 'https://hn.algolia.com/api/v1/items';
const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3/videos';

export interface PlatformMetadataResult {
	sourceType: string;
	platformMetadata: {
		type: string;
		fetchedAt: string;
		data: Record<string, unknown>;
	} | null;
}

/**
 * Fetches platform metadata based on URL type
 * @param url - The main article URL
 * @param youtubeApiKey - Optional YouTube API key
 * @param commentsUrl - Optional HackerNews comments URL (from RSS <comments> tag)
 */
export async function fetchPlatformMetadata(
	url: string,
	youtubeApiKey?: string,
	commentsUrl?: string
): Promise<PlatformMetadataResult> {
	const platformType = detectPlatformType(url);

	switch (platformType) {
		case 'hackernews':
			return fetchHnMetadata(url);
		case 'youtube':
			return fetchYouTubeMetadata(url, youtubeApiKey);
		default:
			// Check if commentsUrl is a HackerNews URL (RSS feeds have HN link in <comments>)
			if (commentsUrl) {
				const commentsPlatform = detectPlatformType(commentsUrl);
				if (commentsPlatform === 'hackernews') {
					console.log(`[PLATFORM-METADATA] Found HN comments URL: ${commentsUrl}`);
					return fetchHnMetadata(commentsUrl);
				}
			}
			return { sourceType: 'rss', platformMetadata: null };
	}
}

/**
 * Fetches HackerNews metadata from Algolia API
 */
async function fetchHnMetadata(url: string): Promise<PlatformMetadataResult> {
	const itemId = extractHnItemId(url);
	if (!itemId) {
		return { sourceType: 'rss', platformMetadata: null };
	}

	try {
		const response = await fetch(`${HN_ALGOLIA_API}/${itemId}`);
		if (!response.ok) {
			console.error(`[PLATFORM-METADATA] HN API error: ${response.status}`);
			return { sourceType: 'hackernews', platformMetadata: null };
		}

		const data = await response.json() as {
			id: number;
			author?: string;
			points?: number;
			descendants?: number;
			type?: string;
		};

		return {
			sourceType: 'hackernews',
			platformMetadata: {
				type: 'hackernews',
				fetchedAt: new Date().toISOString(),
				data: {
					author: data.author || '',
					points: data.points || 0,
					commentCount: data.descendants || 0,
					itemId: data.id.toString(),
					itemType: data.type || 'story',
				},
			},
		};
	} catch (error) {
		console.error('[PLATFORM-METADATA] Failed to fetch HN metadata:', error);
		return { sourceType: 'hackernews', platformMetadata: null };
	}
}

/**
 * Fetches YouTube metadata from YouTube Data API
 */
async function fetchYouTubeMetadata(
	url: string,
	apiKey?: string
): Promise<PlatformMetadataResult> {
	const videoId = extractYouTubeVideoId(url);
	if (!videoId) {
		return { sourceType: 'youtube', platformMetadata: null };
	}

	if (!apiKey) {
		console.warn('[PLATFORM-METADATA] YouTube API key not provided');
		return { sourceType: 'youtube', platformMetadata: null };
	}

	try {
		const apiUrl = `${YOUTUBE_API}?part=snippet,statistics,contentDetails&id=${videoId}&key=${apiKey}`;
		const response = await fetch(apiUrl);

		if (!response.ok) {
			console.error(`[PLATFORM-METADATA] YouTube API error: ${response.status}`);
			return { sourceType: 'youtube', platformMetadata: null };
		}

		const data = await response.json() as {
			items?: Array<{
				snippet?: {
					channelTitle?: string;
					channelId?: string;
					publishedAt?: string;
					description?: string;
					thumbnails?: {
						maxres?: { url: string };
						high?: { url: string };
						default?: { url: string };
					};
				};
				statistics?: {
					viewCount?: string;
					likeCount?: string;
				};
				contentDetails?: {
					duration?: string;
				};
			}>;
		};

		const video = data.items?.[0];
		if (!video) {
			return { sourceType: 'youtube', platformMetadata: null };
		}

		return {
			sourceType: 'youtube',
			platformMetadata: {
				type: 'youtube',
				fetchedAt: new Date().toISOString(),
				data: {
					videoId,
					channelName: video.snippet?.channelTitle || '',
					channelId: video.snippet?.channelId || '',
					duration: video.contentDetails?.duration || '',
					thumbnailUrl:
						video.snippet?.thumbnails?.maxres?.url ||
						video.snippet?.thumbnails?.high?.url ||
						video.snippet?.thumbnails?.default?.url ||
						'',
					viewCount: parseInt(video.statistics?.viewCount || '0', 10),
					likeCount: parseInt(video.statistics?.likeCount || '0', 10),
					publishedAt: video.snippet?.publishedAt || '',
					// Full description for chapter parsing
					description: video.snippet?.description || '',
				},
			},
		};
	} catch (error) {
		console.error('[PLATFORM-METADATA] Failed to fetch YouTube metadata:', error);
		return { sourceType: 'youtube', platformMetadata: null };
	}
}
