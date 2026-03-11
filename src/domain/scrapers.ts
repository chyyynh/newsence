// ─────────────────────────────────────────────────────────────
// Platform Scrapers (merged from crawler)
// ─────────────────────────────────────────────────────────────

import { logInfo, logWarn } from '../infra/log';
import { YOUTUBE_SHORT_HOSTS, YOUTUBE_WATCH_HOSTS } from '../infra/web';
import type { TwitterMedia } from '../models/platform-metadata';

export interface ScrapedContent {
	title: string;
	content: string;
	summary?: string;
	ogImageUrl: string | null;
	siteName: string | null;
	author: string | null;
	publishedDate: string | null;
	metadata?: Record<string, unknown>;
	/** YouTube-only: transcript data to save to youtube_transcripts table */
	youtubeTranscript?: {
		videoId: string;
		segments: TranscriptSegment[];
		language: string | null;
		chapters: YouTubeChapter[];
		chaptersFromDescription: boolean;
	};
}

// ─────────────────────────────────────────────────────────────
// URL Extraction Utilities
// ─────────────────────────────────────────────────────────────

export type PlatformType = 'hackernews' | 'youtube' | 'twitter' | 'web';

const HACKERNEWS_HOSTS = new Set(['news.ycombinator.com', 'ycombinator.com', 'www.ycombinator.com']);
const TWITTER_HOSTS = new Set(['twitter.com', 'x.com', 'www.twitter.com', 'www.x.com', 'mobile.twitter.com']);

export function detectPlatformType(url: string): PlatformType {
	try {
		const hostname = new URL(url).hostname.toLowerCase();
		if (HACKERNEWS_HOSTS.has(hostname)) return 'hackernews';
		if (YOUTUBE_WATCH_HOSTS.has(hostname) || YOUTUBE_SHORT_HOSTS.has(hostname)) return 'youtube';
		if (TWITTER_HOSTS.has(hostname)) return 'twitter';
		return 'web';
	} catch {
		return 'web';
	}
}

export function extractTweetId(url: string): string | null {
	const match = url.match(/(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/);
	return match?.[1] ?? null;
}

export function extractYouTubeId(url: string): string | null {
	const patterns = [
		/[?&]v=([a-zA-Z0-9_-]{11})/,
		/youtu\.be\/([a-zA-Z0-9_-]{11})/,
		/\/embed\/([a-zA-Z0-9_-]{11})/,
		/\/shorts\/([a-zA-Z0-9_-]{11})/,
		/\/v\/([a-zA-Z0-9_-]{11})/,
	];
	for (const pattern of patterns) {
		const match = url.match(pattern);
		if (match) return match[1];
	}
	return null;
}

export function extractHackerNewsId(url: string): string | null {
	const match = url.match(/[?&]id=(\d+)/);
	return match?.[1] ?? null;
}

// ─────────────────────────────────────────────────────────────
// YouTube Scraper
// ─────────────────────────────────────────────────────────────

interface YouTubeVideoItem {
	id: string;
	snippet: {
		title: string;
		description: string;
		channelId: string;
		channelTitle: string;
		publishedAt: string;
		thumbnails: {
			default?: { url: string };
			medium?: { url: string };
			high?: { url: string };
			standard?: { url: string };
			maxres?: { url: string };
		};
		tags?: string[];
	};
	contentDetails: {
		duration: string;
	};
	statistics: {
		viewCount?: string;
		likeCount?: string;
		commentCount?: string;
	};
}

interface TranscriptSegment {
	startTime: number;
	endTime: number;
	text: string;
}

interface YouTubeChapter {
	title: string;
	startTime: number;
	endTime: number;
}

function parseChaptersFromDescription(description: string): YouTubeChapter[] {
	const chapterRegex = /(?:^|\n)(\d{1,2}:)?(\d{1,2}):(\d{2})\s+(.+?)(?=\n|$)/g;
	const chapters: YouTubeChapter[] = [];

	let match;
	while ((match = chapterRegex.exec(description)) !== null) {
		const hours = match[1] ? parseInt(match[1].replace(':', ''), 10) : 0;
		const minutes = parseInt(match[2], 10);
		const seconds = parseInt(match[3], 10);
		const title = match[4].trim();

		if (title.length < 2 || /^\d+:\d+/.test(title)) continue;

		const startTime = hours * 3600 + minutes * 60 + seconds;
		chapters.push({ title, startTime, endTime: 0 });
	}

	for (let i = 0; i < chapters.length; i++) {
		chapters[i].endTime = chapters[i + 1]?.startTime ?? Number.MAX_SAFE_INTEGER;
	}

	return chapters.length >= 2 ? chapters : [];
}

const EMPTY_TRANSCRIPT: { segments: TranscriptSegment[]; language: string | null } = { segments: [], language: null };

async function fetchTranscript(
	videoId: string,
	clipApiUrl: string,
	clipApiSecret: string,
): Promise<{ segments: TranscriptSegment[]; language: string | null }> {
	logInfo('YOUTUBE', 'Fetching transcript via clip-api', { videoId });

	const response = await fetch(`${clipApiUrl}/transcript`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${clipApiSecret}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ videoId }),
	});

	if (!response.ok) {
		const errorBody = await response.text().catch(() => '');
		logWarn('YOUTUBE', 'clip-api transcript failed', { status: response.status, body: errorBody.slice(0, 200) });
		return EMPTY_TRANSCRIPT;
	}

	const json = (await response.json()) as {
		ok?: boolean;
		data?: { segments: Array<{ startTime: number; endTime: number; text: string }>; language: string };
		// Legacy format
		status?: string;
		result?: { segments: Array<{ startTime: number; endTime: number; text: string }>; language: string };
		error?: string;
	};

	// Current envelope format: { ok, data: { segments, language } }
	const result = json.data ?? (json.status === 'done' ? json.result : undefined);
	if (result?.segments) {
		logInfo('YOUTUBE', 'Transcript fetched', { count: result.segments.length });
		return { segments: result.segments, language: result.language };
	}

	logWarn('YOUTUBE', 'Transcript failed', { error: json.error });
	return EMPTY_TRANSCRIPT;
}

export async function scrapeYouTube(
	videoId: string,
	youtubeApiKey: string,
	clipApiUrl?: string,
	clipApiSecret?: string,
): Promise<ScrapedContent> {
	logInfo('YOUTUBE', 'Fetching video', { videoId });

	const videoResponse = await fetch(
		`https://www.googleapis.com/youtube/v3/videos?id=${videoId}&part=snippet,contentDetails,statistics&key=${youtubeApiKey}`,
	);

	if (!videoResponse.ok) {
		throw new Error(`YouTube API error: HTTP ${videoResponse.status}`);
	}

	const videoData = (await videoResponse.json()) as { items?: YouTubeVideoItem[]; error?: { message: string } };

	if (videoData.error) throw new Error(`YouTube API: ${videoData.error.message}`);
	if (!videoData.items?.length) throw new Error('Video not found');

	const video = videoData.items[0];
	const snippet = video.snippet;
	const stats = video.statistics;

	// Fetch channel avatar
	let channelAvatar: string | null = null;
	try {
		const channelResponse = await fetch(
			`https://www.googleapis.com/youtube/v3/channels?id=${snippet.channelId}&part=snippet&key=${youtubeApiKey}`,
		);
		if (channelResponse.ok) {
			const channelData = (await channelResponse.json()) as {
				items?: Array<{ snippet: { thumbnails: { medium?: { url: string }; default?: { url: string } } } }>;
			};
			channelAvatar = channelData.items?.[0]?.snippet?.thumbnails?.medium?.url ?? null;
		}
	} catch (e) {
		logWarn('YOUTUBE', 'Failed to fetch channel avatar', { error: String(e) });
	}

	const thumbnailUrl =
		snippet.thumbnails.maxres?.url ||
		snippet.thumbnails.standard?.url ||
		snippet.thumbnails.high?.url ||
		snippet.thumbnails.medium?.url ||
		null;

	const chapters = parseChaptersFromDescription(snippet.description);

	// Fetch transcript via clip-api (if configured)
	let transcriptResult = EMPTY_TRANSCRIPT;
	if (clipApiUrl && clipApiSecret) {
		try {
			transcriptResult = await fetchTranscript(videoId, clipApiUrl, clipApiSecret);
		} catch (e) {
			logWarn('YOUTUBE', 'Failed to fetch transcript', { error: String(e) });
		}
	}
	const { segments: transcript, language: transcriptLanguage } = transcriptResult;

	logInfo('YOUTUBE', 'Video fetched', { title: snippet.title });

	return {
		title: snippet.title,
		content: '',
		summary: snippet.description.substring(0, 500) || undefined,
		ogImageUrl: thumbnailUrl,
		siteName: 'YouTube',
		author: snippet.channelTitle,
		publishedDate: snippet.publishedAt,
		metadata: {
			videoId: video.id,
			channelName: snippet.channelTitle,
			channelId: snippet.channelId,
			channelAvatar,
			duration: video.contentDetails.duration,
			thumbnailUrl,
			viewCount: stats.viewCount ? parseInt(stats.viewCount) : undefined,
			likeCount: stats.likeCount ? parseInt(stats.likeCount) : undefined,
			commentCount: stats.commentCount ? parseInt(stats.commentCount) : undefined,
			tags: snippet.tags || [],
			publishedAt: snippet.publishedAt,
			description: snippet.description || '',
		},
		youtubeTranscript:
			transcript.length > 0
				? { videoId: video.id, segments: transcript, language: transcriptLanguage, chapters, chaptersFromDescription: chapters.length > 0 }
				: undefined,
	};
}

// ─────────────────────────────────────────────────────────────
// Twitter Scraper
// ─────────────────────────────────────────────────────────────

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
		urls?: Array<{ expanded_url: string }>;
	};
}

interface TwitterArticle {
	title: string;
	preview_text: string;
	cover_media_img_url?: string;
	contents: Array<{ text: string }>;
	author?: {
		userName: string;
		name: string;
		isBlueVerified?: boolean;
		profilePicture?: string;
	};
	viewCount?: number;
	likeCount?: number;
	replyCount?: number;
	quoteCount?: number;
	createdAt?: string;
}

export async function scrapeTwitterArticle(tweetId: string, apiKey: string): Promise<ScrapedContent | null> {
	logInfo('TWITTER', 'Fetching article for tweet', { tweetId });

	const response = await fetch(`https://api.twitterapi.io/twitter/article?tweet_id=${tweetId}`, {
		headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
	});

	if (!response.ok) return null;

	const data = (await response.json()) as { article?: TwitterArticle; status: string; message?: string };
	if (data.status !== 'success' || !data.article) return null;

	const article = data.article;
	const contentText = article.contents.map((c) => c.text).join('\n\n');

	let md = `# ${article.title}\n\n`;
	if (article.author) {
		md += `**Author:** ${article.author.name || article.author.userName}`;
		if (article.author.isBlueVerified) md += ' ✓';
		md += ` (@${article.author.userName})\n\n`;
	}
	if (article.cover_media_img_url) md += `![Cover](${article.cover_media_img_url})\n\n`;
	md += `${contentText}\n\n---\n\n**Engagement:**\n`;
	md += `- Views: ${(article.viewCount || 0).toLocaleString()}\n`;
	md += `- Likes: ${(article.likeCount || 0).toLocaleString()}\n`;
	md += `- Replies: ${(article.replyCount || 0).toLocaleString()}\n`;

	logInfo('TWITTER', 'Article fetched', { title: article.title });

	return {
		title: article.title,
		content: md,
		summary: article.preview_text,
		ogImageUrl: article.cover_media_img_url || article.author?.profilePicture || null,
		siteName: 'Twitter',
		author: article.author?.userName || null,
		publishedDate: article.createdAt || null,
		metadata: {
			variant: 'article',
			tweetId,
			authorName: article.author?.name ?? '',
			authorUserName: article.author?.userName ?? '',
			authorProfilePicture: article.author?.profilePicture,
			authorVerified: article.author?.isBlueVerified,
		},
	};
}

interface TweetAuthor {
	authorName: string;
	authorUserName: string;
	authorProfilePicture?: string;
	authorVerified?: boolean;
}

function extractTweetAuthor(tweet: KaitoTweet): TweetAuthor {
	return {
		authorName: tweet.author?.name ?? '',
		authorUserName: tweet.author?.userName ?? '',
		authorProfilePicture: tweet.author?.profilePicture,
		authorVerified: tweet.author?.isBlueVerified,
	};
}

function extractMedia(media?: Array<{ media_url_https: string; type: string }>): TwitterMedia[] {
	return media?.map((m) => ({ url: m.media_url_https, type: m.type as TwitterMedia['type'] })) ?? [];
}

function buildTweetMetadata(
	tweet: KaitoTweet,
	_hashtags: string[],
	expandedUrls: string[],
	media?: Array<{ media_url_https: string; type: string }>,
	extra?: Record<string, unknown>,
): Record<string, unknown> {
	const externalUrl = expandedUrls.find((u) => !/(?:twitter\.com|x\.com|t\.co)/.test(u));
	const tweetText = tweet.text.replace(/https?:\/\/\S+/g, '').trim();
	const tweetMedia = extractMedia(media);

	return {
		tweetId: tweet.id,
		...extractTweetAuthor(tweet),
		media: tweetMedia,
		createdAt: tweet.createdAt,
		...(externalUrl && {
			variant: 'shared',
			externalUrl,
			tweetText,
		}),
		...extra,
	};
}

export async function scrapeTweet(tweetId: string, apiKey: string, env: Env): Promise<ScrapedContent> {
	logInfo('TWITTER', 'Fetching tweet', { tweetId });

	const response = await fetch(`https://api.twitterapi.io/twitter/tweets?tweet_ids=${tweetId}`, {
		headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
	});

	if (!response.ok) throw new Error(`Kaito API error: HTTP ${response.status}`);

	const data = (await response.json()) as { tweets?: KaitoTweet[]; status: string; msg?: string };
	if (!data.tweets?.length) {
		throw new Error(`Kaito API: Tweet not found (status=${data.status})`);
	}

	const tweet = data.tweets[0];
	const media = tweet.extendedEntities?.media;
	const ogImageUrl = media?.length ? media[0].media_url_https : null;
	const hashtags = tweet.entities?.hashtags?.map((h) => h.text) || [];
	const expandedUrls = tweet.entities?.urls?.map((u) => u.expanded_url).filter(Boolean) || [];

	const articleUrl = expandedUrls.find((u) => /(?:twitter\.com|x\.com)\/i\/article\//.test(u));
	const externalUrl = expandedUrls.find((u) => !/(?:twitter\.com|x\.com|t\.co)/.test(u));

	// 1. Twitter Article — detected by expanded_url containing /i/article/
	if (articleUrl) {
		logInfo('TWITTER', 'Detected Twitter Article', { articleUrl });
		const articleContent = await scrapeTwitterArticle(tweetId, apiKey);
		if (articleContent) return articleContent;
		logWarn('TWITTER', 'Article API failed, falling through to regular tweet handling', {});
	}

	// 2. Tweet has external link — scrape the linked page directly
	if (externalUrl) {
		logInfo('TWITTER', 'Tweet has external link, scraping', { externalUrl });
		try {
			const linked = await scrapeWebPage(externalUrl, env);
			if (linked.content && linked.content.length > 100) {
				logInfo('TWITTER', 'Scraped linked article', { title: linked.title });
				return {
					title: linked.title || `@${tweet.author?.userName}: ${tweet.text.substring(0, 80)}`,
					content: linked.content,
					summary: linked.summary || tweet.text,
					ogImageUrl: linked.ogImageUrl || ogImageUrl || tweet.author?.profilePicture || null,
					siteName: linked.siteName || 'Twitter',
					author: tweet.author?.userName || linked.author || null,
					publishedDate: tweet.createdAt,
					metadata: {
						variant: 'shared',
						tweetId: tweet.id,
						...extractTweetAuthor(tweet),
						media: extractMedia(media),
						createdAt: tweet.createdAt,
						tweetText: tweet.text.replace(/https?:\/\/\S+/g, '').trim(),
						externalUrl,
						externalOgImage: linked.ogImageUrl || null,
						externalTitle: linked.title || null,
						originalTweetUrl: tweet.url,
					},
				};
			}
		} catch (e) {
			logWarn('TWITTER', 'Failed to scrape linked URL', { externalUrl, error: String(e) });
		}
	}

	// 3. Regular tweet — no full content, summary carries the tweet text
	const title = `@${tweet.author?.userName}: ${tweet.text.substring(0, 80)}${tweet.text.length > 80 ? '...' : ''}`;

	logInfo('TWITTER', 'Tweet fetched', { userName: tweet.author?.userName });

	return {
		title,
		content: '',
		summary: tweet.text,
		ogImageUrl: ogImageUrl || tweet.author?.profilePicture || null,
		siteName: 'Twitter',
		author: tweet.author?.userName || null,
		publishedDate: tweet.createdAt,
		metadata: buildTweetMetadata(tweet, hashtags, expandedUrls, media),
	};
}

// ─────────────────────────────────────────────────────────────
// HackerNews Scraper
// ─────────────────────────────────────────────────────────────

export const HN_ALGOLIA_API = 'https://hn.algolia.com/api/v1/items';

interface HNItem {
	id: number;
	title: string;
	url?: string;
	author: string;
	points: number;
	descendants?: number;
	type: 'story' | 'ask' | 'show' | 'job' | 'comment' | 'poll';
	created_at_i: number;
	text?: string;
}

function buildHnMarkdown(item: HNItem): string {
	const parts: string[] = [`# ${item.title}\n`];

	const metaParts: string[] = [];
	if (item.points !== undefined) metaParts.push(`${item.points} points`);
	if (item.author) metaParts.push(`by ${item.author}`);
	if (item.descendants !== undefined) metaParts.push(`${item.descendants} comments`);
	if (metaParts.length) parts.push(`*${metaParts.join(' | ')}*\n`);

	if (item.url) parts.push(`**Original:** [${item.url}](${item.url})\n`);
	if (item.text) parts.push(`---\n\n${item.text}\n`);

	parts.push(`\n---\n\n[View Discussion on Hacker News](https://news.ycombinator.com/item?id=${item.id})`);

	return parts.join('\n');
}

export async function scrapeHackerNews(itemId: string): Promise<ScrapedContent> {
	logInfo('HN', 'Fetching item', { itemId });

	const response = await fetch(`${HN_ALGOLIA_API}/${itemId}`);
	if (!response.ok) throw new Error(`HN API error: ${response.status}`);

	const item: HNItem = await response.json();

	let summary = item.text?.slice(0, 200) || item.title;
	if (item.text && item.text.length > 200) summary += '...';

	logInfo('HN', 'Item fetched', { title: item.title });

	return {
		title: item.title || `HN Item ${itemId}`,
		content: buildHnMarkdown(item),
		summary,
		ogImageUrl: null,
		siteName: 'Hacker News',
		author: item.author || null,
		publishedDate: item.created_at_i ? new Date(item.created_at_i * 1000).toISOString() : null,
		metadata: {
			itemId: item.id.toString(),
			points: item.points || 0,
			commentCount: item.descendants || 0,
			itemType: item.type,
			author: item.author,
			storyUrl: item.url || null,
		},
	};
}

// ─────────────────────────────────────────────────────────────
// Web Scraper (Cloudflare Browser Rendering /crawl API)
// ─────────────────────────────────────────────────────────────

import { crawlPage } from '../infra/crawl';
import type { Env } from '../models/types';

export async function scrapeWebPage(url: string, env: Env): Promise<ScrapedContent> {
	logInfo('WEB', 'Scraping via crawl API', { url });

	const result = await crawlPage(url, env.CF_ACCOUNT_ID, env.CF_API_TOKEN);

	return {
		title: result.title,
		content: result.markdown,
		summary: result.description || undefined,
		ogImageUrl: result.ogImageUrl,
		siteName: result.siteName,
		author: result.author,
		publishedDate: result.publishedDate,
	};
}

// ─────────────────────────────────────────────────────────────
// Unified Scraper
// ─────────────────────────────────────────────────────────────

export interface ScrapeOptions {
	env: Env;
	youtubeApiKey?: string;
	clipApiUrl?: string;
	clipApiSecret?: string;
	kaitoApiKey?: string;
}

export async function scrapeUrl(url: string, options: ScrapeOptions): Promise<ScrapedContent> {
	const platformType = detectPlatformType(url);

	switch (platformType) {
		case 'youtube': {
			const videoId = extractYouTubeId(url);
			if (!videoId) throw new Error('Invalid YouTube URL');
			if (!options.youtubeApiKey) throw new Error('YouTube API key required');
			return scrapeYouTube(videoId, options.youtubeApiKey, options.clipApiUrl, options.clipApiSecret);
		}

		case 'twitter': {
			const tweetId = extractTweetId(url);
			if (!tweetId) throw new Error('Invalid Twitter URL');
			if (!options.kaitoApiKey) throw new Error('Kaito API key required');
			return scrapeTweet(tweetId, options.kaitoApiKey, options.env);
		}

		case 'hackernews': {
			const itemId = extractHackerNewsId(url);
			if (!itemId) throw new Error('Invalid HackerNews URL');
			return scrapeHackerNews(itemId);
		}

		default:
			return scrapeWebPage(url, options.env);
	}
}
