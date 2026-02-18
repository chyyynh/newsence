import { detectPlatformType, extractHackerNewsId, extractYouTubeId, extractTweetId, HN_ALGOLIA_API } from '../domain/scrapers';
import { logInfo, logWarn, logError } from './log';

// ─────────────────────────────────────────────────────────────
// Platform Metadata
// ─────────────────────────────────────────────────────────────

const YOUTUBE_VIDEO_API = 'https://www.googleapis.com/youtube/v3/videos';
const YOUTUBE_CHANNEL_API = 'https://www.googleapis.com/youtube/v3/channels';
const KAITO_API = 'https://api.twitterapi.io/twitter/tweets';

interface PlatformMetadataResult {
	sourceType: string;
	platformMetadata: {
		type: string;
		fetchedAt: string;
		data: Record<string, unknown>;
	} | null;
}

function createMetadata(type: string, data: Record<string, unknown>): PlatformMetadataResult['platformMetadata'] {
	return { type, fetchedAt: new Date().toISOString(), data };
}

function emptyResult(sourceType: string): PlatformMetadataResult {
	return { sourceType, platformMetadata: null };
}

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
			if (commentsUrl && detectPlatformType(commentsUrl) === 'hackernews') {
				logInfo('PLATFORM', 'Found HN comments URL', { url: commentsUrl });
				return fetchHnMetadata(commentsUrl);
			}
			return emptyResult('rss');
	}
}

async function fetchHnMetadata(url: string): Promise<PlatformMetadataResult> {
	const itemId = extractHackerNewsId(url);
	if (!itemId) return emptyResult('rss');

	try {
		const response = await fetch(`${HN_ALGOLIA_API}/${itemId}`);
		if (!response.ok) {
			logError('PLATFORM', 'HN API error', { status: response.status });
			return emptyResult('hackernews');
		}

		const data = (await response.json()) as {
			id: number;
			author?: string;
			points?: number;
			descendants?: number;
			type?: string;
		};

		return {
			sourceType: 'hackernews',
			platformMetadata: createMetadata('hackernews', {
				author: data.author ?? '',
				points: data.points ?? 0,
				commentCount: data.descendants ?? 0,
				itemId: data.id.toString(),
				itemType: data.type ?? 'story',
			}),
		};
	} catch (error) {
		logError('PLATFORM', 'Failed to fetch HN metadata', { error: String(error) });
		return emptyResult('hackernews');
	}
}

async function fetchChannelAvatar(channelId: string, apiKey: string): Promise<string | null> {
	try {
		const response = await fetch(`${YOUTUBE_CHANNEL_API}?part=snippet&id=${channelId}&key=${apiKey}`);
		if (!response.ok) {
			logError('PLATFORM', 'YouTube Channels API error', { status: response.status });
			return null;
		}

		const data = (await response.json()) as {
			items?: Array<{
				snippet?: {
					thumbnails?: {
						default?: { url: string };
						medium?: { url: string };
					};
				};
			}>;
		};

		const thumbnails = data.items?.[0]?.snippet?.thumbnails;
		return thumbnails?.medium?.url ?? thumbnails?.default?.url ?? null;
	} catch (error) {
		logError('PLATFORM', 'Failed to fetch channel avatar', { error: String(error) });
		return null;
	}
}

async function fetchYouTubeMetadata(url: string, apiKey?: string): Promise<PlatformMetadataResult> {
	const videoId = extractYouTubeId(url);
	if (!videoId || !apiKey) {
		if (!apiKey) logWarn('PLATFORM', 'YouTube API key not provided');
		return emptyResult('youtube');
	}

	try {
		const response = await fetch(`${YOUTUBE_VIDEO_API}?part=snippet,statistics,contentDetails&id=${videoId}&key=${apiKey}`);
		if (!response.ok) {
			logError('PLATFORM', 'YouTube API error', { status: response.status });
			return emptyResult('youtube');
		}

		const data = (await response.json()) as {
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
		if (!video) return emptyResult('youtube');

		const channelAvatar = video.snippet?.channelId ? await fetchChannelAvatar(video.snippet.channelId, apiKey) : null;
		const thumbnails = video.snippet?.thumbnails;

		return {
			sourceType: 'youtube',
			platformMetadata: createMetadata('youtube', {
				videoId,
				channelName: video.snippet?.channelTitle ?? '',
				channelId: video.snippet?.channelId ?? '',
				channelAvatar: channelAvatar ?? undefined,
				duration: video.contentDetails?.duration ?? '',
				thumbnailUrl: thumbnails?.maxres?.url ?? thumbnails?.high?.url ?? thumbnails?.default?.url ?? '',
				viewCount: parseInt(video.statistics?.viewCount ?? '0', 10),
				likeCount: parseInt(video.statistics?.likeCount ?? '0', 10),
				publishedAt: video.snippet?.publishedAt ?? '',
				description: video.snippet?.description ?? '',
			}),
		};
	} catch (error) {
		logError('PLATFORM', 'Failed to fetch YouTube metadata', { error: String(error) });
		return emptyResult('youtube');
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
		urls?: Array<{ expanded_url: string }>;
	};
}

async function fetchTwitterMetadata(url: string, apiKey?: string): Promise<PlatformMetadataResult> {
	const tweetId = extractTweetId(url);
	if (!tweetId || !apiKey) {
		if (!apiKey) logWarn('PLATFORM', 'Kaito API key not provided');
		return emptyResult('twitter');
	}

	try {
		const response = await fetch(`${KAITO_API}?tweet_ids=${tweetId}`, {
			headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
		});

		if (!response.ok) {
			logError('PLATFORM', 'Kaito API error', { status: response.status });
			return emptyResult('twitter');
		}

		const data = (await response.json()) as {
			tweets?: KaitoTweet[];
			status: string;
			msg?: string;
		};

		if (data.status !== 'success' || !data.tweets?.length) {
			logError('PLATFORM', 'Kaito API error', { msg: data.msg ?? 'Tweet not found' });
			return emptyResult('twitter');
		}

		const tweet = data.tweets[0];
		logInfo('PLATFORM', 'Fetched Twitter metadata', { author: tweet.author?.userName });

		const tweetMedia = tweet.extendedEntities?.media;
		const externalUrl = tweet.entities?.urls
			?.map((u) => u.expanded_url)
			.find((u) => !/(?:twitter\.com|x\.com|t\.co)/.test(u));

		return {
			sourceType: 'twitter',
			platformMetadata: createMetadata('twitter', {
				authorName: tweet.author?.name ?? '',
				authorUserName: tweet.author?.userName ?? '',
				authorProfilePicture: tweet.author?.profilePicture,
				authorVerified: tweet.author?.isBlueVerified,
				mediaUrls: tweetMedia?.map((m) => m.media_url_https) ?? [],
				media: tweetMedia?.map((m) => ({ url: m.media_url_https, type: m.type })) ?? [],
				...(externalUrl ? { externalUrl } : {}),
				createdAt: tweet.createdAt,
			}),
		};
	} catch (error) {
		logError('PLATFORM', 'Failed to fetch Twitter metadata', { error: String(error) });
		return emptyResult('twitter');
	}
}
