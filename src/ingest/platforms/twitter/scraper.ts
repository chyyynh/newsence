// ─────────────────────────────────────────────────────────────
// Twitter Scraper
// ─────────────────────────────────────────────────────────────

import {
	buildMetadata,
	type PlatformMetadata,
	type QuotedTweetData,
	type RetweetedByData,
	type TwitterAuthorFields,
	type TwitterMedia,
} from '@shared/platform-metadata';
import { fetchJsonWithTimeout, type ScrapedContent } from '@shared/web';

interface TwitterUrlEntity {
	expanded_url?: string;
	url?: string;
}

interface TwitterMediaEntity {
	media_url_https?: string;
	type?: string;
	sizes?: { large?: { w: number; h: number } };
	video_info?: { variants?: Array<{ bitrate?: number; content_type?: string; url: string }> };
}

export interface TwitterLikeTweet {
	id?: string;
	url?: string;
	text: string;
	createdAt?: string;
	author?: {
		name?: string;
		userName?: string;
		profilePicture?: string;
		isBlueVerified?: boolean;
	};
	urls?: TwitterUrlEntity[];
	entities?: { urls?: TwitterUrlEntity[] };
	extendedEntities?: { media?: TwitterMediaEntity[] };
	quoted_tweet?: TwitterLikeTweet | null;
	retweetedBy?: RetweetedByData;
}

export function extractTweetAuthor(tweet: TwitterLikeTweet): TwitterAuthorFields {
	return {
		authorName: tweet.author?.name || '',
		authorUserName: tweet.author?.userName || '',
		authorProfilePicture: tweet.author?.profilePicture,
		authorVerified: tweet.author?.isBlueVerified,
	};
}

export function extractTweetMedia(tweet: TwitterLikeTweet): TwitterMedia[] {
	return (
		tweet.extendedEntities?.media?.flatMap((m) => {
			if (!m.media_url_https) return [];
			const result: TwitterMedia = { url: m.media_url_https, type: m.type as TwitterMedia['type'] };
			if (m.sizes?.large) {
				result.width = m.sizes.large.w;
				result.height = m.sizes.large.h;
			}
			if (m.video_info?.variants) {
				const mp4 = m.video_info.variants
					.filter((v) => v.content_type === 'video/mp4')
					.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
				if (mp4) result.videoUrl = mp4.url;
			}
			return [result];
		}) ?? []
	);
}

export function extractExpandedUrls(tweet: TwitterLikeTweet): string[] {
	const urls = tweet.urls ?? tweet.entities?.urls ?? [];
	return urls.map((u) => u.expanded_url || u.url || '').filter(Boolean);
}

export function stripTweetUrls(text: string): string {
	return text.replace(/https?:\/\/\S+/g, '').trim();
}

export function extractQuotedTweet(tweet: TwitterLikeTweet): QuotedTweetData | undefined {
	const q = tweet.quoted_tweet;
	if (!q?.text || !q.author) return undefined;
	return {
		authorName: q.author.name || '',
		authorUserName: q.author.userName || '',
		authorProfilePicture: q.author.profilePicture,
		text: stripTweetUrls(q.text),
	};
}

export function findTwitterArticleUrl(urls: string[]): string | undefined {
	return urls.find((u) => /(?:twitter\.com|x\.com)\/i\/article\//.test(u));
}

export function findExternalUrl(urls: string[]): string | undefined {
	return urls.find((u) => !/(?:twitter\.com|x\.com|t\.co)/.test(u));
}

export function buildTweetTitle(tweet: TwitterLikeTweet, maxLength = 100): string {
	const suffix = tweet.text.length > maxLength ? '...' : '';
	return `@${tweet.author?.userName}: ${tweet.text.substring(0, maxLength)}${suffix}`;
}

interface TweetMetadataOptions {
	externalUrl?: string;
	externalOgImage?: string | null;
	externalTitle?: string | null;
	originalTweetUrl?: string;
	tweetText?: string;
	media?: TwitterMedia[];
	quotedTweet?: QuotedTweetData;
}

export function buildTweetPlatformMetadata(
	tweet: TwitterLikeTweet,
	options: TweetMetadataOptions = {},
): Extract<PlatformMetadata, { type: 'twitter' }> {
	const media = options.media ?? extractTweetMedia(tweet);
	const tweetText = options.tweetText ?? stripTweetUrls(tweet.text);
	const base = {
		tweetId: tweet.id,
		...extractTweetAuthor(tweet),
		media,
		createdAt: tweet.createdAt,
		retweetedBy: tweet.retweetedBy,
	};

	if (options.externalUrl) {
		return buildMetadata('twitter', {
			variant: 'shared',
			...base,
			tweetText,
			externalUrl: options.externalUrl,
			externalOgImage: options.externalOgImage ?? null,
			externalTitle: options.externalTitle ?? null,
			originalTweetUrl: options.originalTweetUrl,
		});
	}

	return buildMetadata('twitter', { ...base, quotedTweet: options.quotedTweet ?? extractQuotedTweet(tweet) });
}

export function buildTwitterArticlePlatformMetadata(
	tweetId: string,
	author: TwitterLikeTweet['author'] | undefined,
): Extract<PlatformMetadata, { type: 'twitter' }> {
	return buildMetadata('twitter', {
		variant: 'article',
		tweetId,
		authorName: author?.name ?? '',
		authorUserName: author?.userName ?? '',
		authorProfilePicture: author?.profilePicture,
		authorVerified: author?.isBlueVerified,
	});
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
		media?: Array<{
			media_url_https: string;
			type: string;
			sizes?: { large?: { w: number; h: number } };
			video_info?: { variants?: Array<{ bitrate?: number; content_type?: string; url: string }> };
		}>;
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
	console.info({ tag: 'TWITTER', msg: 'Fetching article for tweet', tweetId });

	const data = await fetchJsonWithTimeout<{ article?: TwitterArticle; status: string; message?: string }>(
		`https://api.twitterapi.io/twitter/article?tweet_id=${tweetId}`,
		{ headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' } },
	).catch(() => null);
	if (!data) return null;
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

	console.info({ tag: 'TWITTER', msg: 'Article fetched', title: article.title });

	return {
		title: article.title,
		content: md,
		summary: article.preview_text,
		ogImageUrl: article.cover_media_img_url || article.author?.profilePicture || null,
		siteName: 'Twitter',
		author: article.author?.userName || null,
		publishedDate: article.createdAt || null,
		metadata: { ...buildTwitterArticlePlatformMetadata(tweetId, article.author).data },
	};
}

function buildTweetMetadata(tweet: KaitoTweet, expandedUrls: string[]): Record<string, unknown> {
	const externalUrl = findExternalUrl(expandedUrls);
	const tweetText = stripTweetUrls(tweet.text);

	return { ...buildTweetPlatformMetadata(tweet, externalUrl ? { externalUrl, tweetText } : {}).data };
}

export async function scrapeTweet(tweetId: string, apiKey: string): Promise<ScrapedContent> {
	console.info({ tag: 'TWITTER', msg: 'Fetching tweet', tweetId });

	const data = await fetchJsonWithTimeout<{ tweets?: KaitoTweet[]; status: string; msg?: string }>(
		`https://api.twitterapi.io/twitter/tweets?tweet_ids=${tweetId}`,
		{ headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' } },
	);
	if (!data.tweets?.length) {
		throw new Error(`Kaito API: Tweet not found (status=${data.status})`);
	}

	const tweet = data.tweets[0];
	const media = extractTweetMedia(tweet);
	const ogImageUrl = media[0]?.url ?? null;
	const expandedUrls = extractExpandedUrls(tweet);

	const articleUrl = findTwitterArticleUrl(expandedUrls);
	const externalUrl = findExternalUrl(expandedUrls);

	// 1. Twitter Article — detected by expanded_url containing /i/article/
	if (articleUrl) {
		console.info({ tag: 'TWITTER', msg: 'Detected Twitter Article', articleUrl });
		const articleContent = await scrapeTwitterArticle(tweetId, apiKey);
		if (articleContent) return articleContent;
		console.warn({ tag: 'TWITTER', msg: 'Article API failed, falling through to regular tweet handling' });
	}

	// 2. Tweet has external link — scrape the linked page directly
	if (externalUrl) {
		console.info({ tag: 'TWITTER', msg: 'Tweet has external link, scraping', externalUrl });
		try {
			// Import scrapeWebPage at call site to avoid circular dependency
			const { scrapeWebPage } = await import('../web-scraper');
			const linked = await scrapeWebPage(externalUrl);
			if (linked.content && linked.content.length > 100) {
				console.info({ tag: 'TWITTER', msg: 'Scraped linked article', title: linked.title });
				return {
					title: linked.title || `@${tweet.author?.userName}: ${tweet.text.substring(0, 80)}`,
					content: linked.content,
					summary: linked.summary || tweet.text,
					ogImageUrl: linked.ogImageUrl || ogImageUrl || tweet.author?.profilePicture || null,
					siteName: linked.siteName || 'Twitter',
					author: tweet.author?.userName || linked.author || null,
					publishedDate: tweet.createdAt,
					metadata: {
						...buildTweetPlatformMetadata(tweet, {
							media,
							tweetText: stripTweetUrls(tweet.text),
							externalUrl,
							externalOgImage: linked.ogImageUrl || null,
							externalTitle: linked.title || null,
							originalTweetUrl: tweet.url,
						}).data,
					},
				};
			}
		} catch (e) {
			console.warn({ tag: 'TWITTER', msg: 'Failed to scrape linked URL', externalUrl, error: String(e) });
		}
	}

	// 3. Regular tweet — no full content, summary carries the tweet text
	const title = buildTweetTitle(tweet, 80);

	console.info({ tag: 'TWITTER', msg: 'Tweet fetched', userName: tweet.author?.userName });

	return {
		title,
		content: '',
		summary: tweet.text,
		ogImageUrl: ogImageUrl || tweet.author?.profilePicture || null,
		siteName: 'Twitter',
		author: tweet.author?.userName || null,
		publishedDate: tweet.createdAt,
		metadata: buildTweetMetadata(tweet, expandedUrls),
	};
}
