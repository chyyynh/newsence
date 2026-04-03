// ─────────────────────────────────────────────────────────────
// Twitter Scraper
// ─────────────────────────────────────────────────────────────

import { logInfo, logWarn } from '../../infra/log';
import type { ScrapedContent } from '../../models/scraped-content';
import type { TwitterMedia } from './metadata';

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

export function buildTweetMetadata(
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

export async function scrapeTweet(tweetId: string, apiKey: string): Promise<ScrapedContent> {
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
			// Import scrapeWebPage at call site to avoid circular dependency
			const { scrapeWebPage } = await import('../web/scraper');
			const linked = await scrapeWebPage(externalUrl);
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
