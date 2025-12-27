/**
 * Platform Metadata Utilities
 * Fetches platform-specific metadata for HackerNews and YouTube
 */

import { detectPlatformType, extractHnItemId, extractYouTubeVideoId, extractTweetId } from './url-detection';

const HN_ALGOLIA_API = 'https://hn.algolia.com/api/v1/items';
const YOUTUBE_VIDEO_API = 'https://www.googleapis.com/youtube/v3/videos';
const YOUTUBE_CHANNEL_API = 'https://www.googleapis.com/youtube/v3/channels';
const KAITO_API = 'https://api.twitterapi.io/twitter/tweets';

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
 * @param kaitoApiKey - Optional Kaito API key for Twitter
 */
export async function fetchPlatformMetadata(
	url: string,
	youtubeApiKey?: string,
	commentsUrl?: string,
	kaitoApiKey?: string
): Promise<PlatformMetadataResult> {
	const platformType = detectPlatformType(url);

	switch (platformType) {
		case 'hackernews':
			return fetchHnMetadata(url);
		case 'youtube':
			return fetchYouTubeMetadata(url, youtubeApiKey);
		case 'twitter':
			return fetchTwitterMetadata(url, kaitoApiKey);
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
 * Fetches channel avatar from YouTube Channels API
 */
async function fetchChannelAvatar(
	channelId: string,
	apiKey: string
): Promise<string | null> {
	try {
		const apiUrl = `${YOUTUBE_CHANNEL_API}?part=snippet&id=${channelId}&key=${apiKey}`;
		const response = await fetch(apiUrl);

		if (!response.ok) {
			console.error(`[PLATFORM-METADATA] YouTube Channels API error: ${response.status}`);
			return null;
		}

		const data = await response.json() as {
			items?: Array<{
				snippet?: {
					thumbnails?: {
						default?: { url: string };
						medium?: { url: string };
						high?: { url: string };
					};
				};
			}>;
		};

		const channel = data.items?.[0];
		return (
			channel?.snippet?.thumbnails?.medium?.url ||
			channel?.snippet?.thumbnails?.default?.url ||
			null
		);
	} catch (error) {
		console.error('[PLATFORM-METADATA] Failed to fetch channel avatar:', error);
		return null;
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
		const apiUrl = `${YOUTUBE_VIDEO_API}?part=snippet,statistics,contentDetails&id=${videoId}&key=${apiKey}`;
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

		// Fetch channel avatar if we have channelId
		let channelAvatar: string | null = null;
		if (video.snippet?.channelId) {
			channelAvatar = await fetchChannelAvatar(video.snippet.channelId, apiKey);
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
					channelAvatar: channelAvatar || undefined,
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

interface KaitoTweet {
	id: string;
	url: string;
	text: string;
	createdAt: string;
	viewCount?: number;
	likeCount?: number;
	retweetCount?: number;
	replyCount?: number;
	quoteCount?: number;
	lang?: string;
	author?: {
		userName: string;
		name: string;
		isBlueVerified?: boolean;
		profilePicture?: string;
	};
	extendedEntities?: {
		media?: Array<{ media_url_https: string; type: string }>;
	};
	entities?: {
		hashtags?: Array<{ text: string }>;
	};
}

/**
 * Fetches Twitter metadata from Kaito API
 */
async function fetchTwitterMetadata(
	url: string,
	apiKey?: string
): Promise<PlatformMetadataResult> {
	const tweetId = extractTweetId(url);
	if (!tweetId) {
		return { sourceType: 'twitter', platformMetadata: null };
	}

	if (!apiKey) {
		console.warn('[PLATFORM-METADATA] Kaito API key not provided');
		return { sourceType: 'twitter', platformMetadata: null };
	}

	try {
		const response = await fetch(`${KAITO_API}?tweet_ids=${tweetId}`, {
			method: 'GET',
			headers: {
				'X-API-Key': apiKey,
				'Content-Type': 'application/json',
			},
		});

		if (!response.ok) {
			console.error(`[PLATFORM-METADATA] Kaito API error: ${response.status}`);
			return { sourceType: 'twitter', platformMetadata: null };
		}

		const data = (await response.json()) as {
			tweets?: KaitoTweet[];
			status: string;
			msg?: string;
		};

		if (data.status !== 'success' || !data.tweets || data.tweets.length === 0) {
			console.error(`[PLATFORM-METADATA] Kaito API error: ${data.msg || 'Tweet not found'}`);
			return { sourceType: 'twitter', platformMetadata: null };
		}

		const tweet = data.tweets[0];
		const mediaUrls = tweet.extendedEntities?.media?.map((m) => m.media_url_https) || [];

		console.log(`[PLATFORM-METADATA] Fetched Twitter metadata for @${tweet.author?.userName}`);

		return {
			sourceType: 'twitter',
			platformMetadata: {
				type: 'twitter',
				fetchedAt: new Date().toISOString(),
				data: {
					authorName: tweet.author?.name || '',
					authorUserName: tweet.author?.userName || '',
					authorProfilePicture: tweet.author?.profilePicture,
					authorVerified: tweet.author?.isBlueVerified,
					viewCount: tweet.viewCount || 0,
					likeCount: tweet.likeCount || 0,
					retweetCount: tweet.retweetCount || 0,
					replyCount: tweet.replyCount || 0,
					quoteCount: tweet.quoteCount || 0,
					mediaUrls,
					createdAt: tweet.createdAt,
				},
			},
		};
	} catch (error) {
		console.error('[PLATFORM-METADATA] Failed to fetch Twitter metadata:', error);
		return { sourceType: 'twitter', platformMetadata: null };
	}
}
