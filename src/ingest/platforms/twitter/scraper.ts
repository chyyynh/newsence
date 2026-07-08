import type { PlatformMetadata, QuotedTweetData, RetweetedByData, TwitterAuthorFields, TwitterMedia } from '@core-shared/platform-metadata';
import type { ScrapedContent } from '@core-shared/types';
import { fetchWithTimeout, readTextWithLimit } from '@core-shared/web';
import { scrapeWebPage } from '../web-scraper';

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

function isTwitterHost(hostname: string): boolean {
	const lower = hostname.toLowerCase();
	return lower === 'twitter.com' || lower.endsWith('.twitter.com') || lower === 'x.com' || lower.endsWith('.x.com');
}

export function extractTweetId(url: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (!isTwitterHost(parsed.hostname)) return null;
	return parsed.pathname.match(/^\/[^/]+\/status\/(\d+)/)?.[1] ?? parsed.pathname.match(/^\/i\/article\/(\d+)/)?.[1] ?? null;
}

function extractTweetAuthor(tweet: TwitterLikeTweet): TwitterAuthorFields {
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

export function findTwitterArticleUrl(urls: string[], tweetUrl?: string): string | undefined {
	return [tweetUrl, ...urls].find((u) => u && /(?:twitter\.com|x\.com)\/i\/article\//.test(u));
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
		return {
			type: 'twitter',
			fetchedAt: new Date().toISOString(),
			data: {
				variant: 'shared',
				...base,
				tweetText,
				externalUrl: options.externalUrl,
				externalOgImage: options.externalOgImage ?? null,
				externalTitle: options.externalTitle ?? null,
				originalTweetUrl: options.originalTweetUrl,
			},
		};
	}

	return {
		type: 'twitter',
		fetchedAt: new Date().toISOString(),
		data: { ...base, quotedTweet: options.quotedTweet ?? extractQuotedTweet(tweet) },
	};
}

export function buildTwitterArticlePlatformMetadata(
	tweetId: string,
	author: TwitterLikeTweet['author'] | undefined,
): Extract<PlatformMetadata, { type: 'twitter' }> {
	return {
		type: 'twitter',
		fetchedAt: new Date().toISOString(),
		data: {
			variant: 'article',
			tweetId,
			authorName: author?.name ?? '',
			authorUserName: author?.userName ?? '',
			authorProfilePicture: author?.profilePicture,
			authorVerified: author?.isBlueVerified,
		},
	};
}

type KaitoTweet = TwitterLikeTweet & {
	id: string;
	url: string;
	createdAt: string;
	viewCount?: number;
	likeCount?: number;
	retweetCount?: number;
	replyCount?: number;
	quoteCount?: number;
	lang?: string;
	author?: TwitterLikeTweet['author'] & {
		userName: string;
		name: string;
	};
};

interface TwitterArticle {
	title?: string;
	preview_text?: string;
	cover_media_img_url?: string;
	contents?: Array<{ text?: string; content?: string }>;
	author?: {
		userName: string;
		name: string;
		isBlueVerified?: boolean;
		profilePicture?: string;
	};
	viewCount?: number;
	likeCount?: number;
	replyCount?: number;
	createdAt?: string;
}

export async function scrapeTwitterArticle(
	tweetId: string,
	apiKey: string,
): Promise<(ScrapedContent & { platformMetadata: Extract<PlatformMetadata, { type: 'twitter' }> }) | null> {
	console.info({ tag: 'TWITTER', msg: 'Fetching article for tweet', tweetId });

	let data: { article?: TwitterArticle; status?: string };
	try {
		const response = await fetchWithTimeout(`https://api.twitterapi.io/twitter/article?tweet_id=${tweetId}`, {
			headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
		});
		if (!response.ok) {
			await response.body?.cancel();
			return null;
		}
		data = JSON.parse(await readTextWithLimit(response)) as { article?: TwitterArticle; status?: string };
	} catch {
		return null;
	}
	if ((data.status && data.status !== 'success') || !data.article) return null;

	const article = data.article;
	const contentText = (article.contents ?? [])
		.map((c) => c.text ?? c.content ?? '')
		.filter(Boolean)
		.join('\n\n');
	if (!article.title && !contentText) return null;
	const title = article.title || `Twitter Article ${tweetId}`;
	const summary = article.preview_text || contentText.slice(0, 280);

	let md = `# ${title}\n\n`;
	if (article.author) {
		md += `**Author:** ${article.author.name || article.author.userName}`;
		if (article.author.isBlueVerified) md += ' ✓';
		if (article.author.userName) md += ` (@${article.author.userName})`;
		md += '\n\n';
	}
	if (article.cover_media_img_url) md += `![Cover](${article.cover_media_img_url})\n\n`;
	md += `${contentText}\n\n---\n\n**Engagement:**\n`;
	if (article.viewCount !== undefined) md += `- Views: ${article.viewCount.toLocaleString()}\n`;
	if (article.likeCount !== undefined) md += `- Likes: ${article.likeCount.toLocaleString()}\n`;
	if (article.replyCount !== undefined) md += `- Replies: ${article.replyCount.toLocaleString()}\n`;

	console.info({ tag: 'TWITTER', msg: 'Article fetched', title });

	return {
		sourceUrl: `https://x.com/i/status/${tweetId}`,
		contentType: 'text/markdown',
		title,
		markdown: md,
		text: md,
		metadata: {
			author: article.author?.userName || null,
			publishedDate: article.createdAt || null,
			siteName: 'Twitter',
			description: summary,
			ogImageUrl: article.cover_media_img_url || article.author?.profilePicture || null,
		},
		status: md.trim().length > 0 ? 'ok' : 'failed',
		platformMetadata: buildTwitterArticlePlatformMetadata(tweetId, article.author),
	};
}

async function scrapeExternalLinkTweet(
	tweet: KaitoTweet,
	externalUrl: string,
	media: TwitterMedia[],
	tweetText: string,
	ogImageUrl: string | null,
): Promise<ScrapedContent> {
	console.info({ tag: 'TWITTER', msg: 'Tweet has external link, scraping', externalUrl });
	try {
		const linked = await scrapeWebPage(externalUrl);
		if (!linked.markdown || linked.markdown.length <= 100) throw new Error('Linked article content too short');
		console.info({ tag: 'TWITTER', msg: 'Scraped linked article', title: linked.title });
		return {
			sourceUrl: externalUrl,
			contentType: linked.contentType,
			title: linked.title || `@${tweet.author?.userName}: ${tweet.text.substring(0, 80)}`,
			markdown: linked.markdown,
			text: linked.text,
			metadata: {
				author: tweet.author?.userName || linked.metadata.author || null,
				publishedDate: tweet.createdAt,
				siteName: linked.metadata.siteName || 'Twitter',
				description: linked.metadata.description || tweet.text,
				ogImageUrl: linked.metadata.ogImageUrl || ogImageUrl || tweet.author?.profilePicture || null,
			},
			status: linked.status,
			platformMetadata: buildTweetPlatformMetadata(tweet, {
				media,
				tweetText,
				externalUrl,
				externalOgImage: linked.metadata.ogImageUrl || null,
				externalTitle: linked.title || null,
				originalTweetUrl: tweet.url,
			}),
		};
	} catch (error) {
		throw new Error(`Failed to scrape linked URL ${externalUrl}: ${String(error)}`);
	}
}

export async function scrapeTweet(tweetId: string, apiKey: string): Promise<ScrapedContent> {
	console.info({ tag: 'TWITTER', msg: 'Fetching tweet', tweetId });

	const response = await fetchWithTimeout(`https://api.twitterapi.io/twitter/tweets?tweet_ids=${tweetId}`, {
		headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`HTTP ${response.status}: ${response.statusText}`);
	}
	const data = JSON.parse(await readTextWithLimit(response)) as { tweets?: KaitoTweet[]; status: string; msg?: string };
	if (!data.tweets?.length) {
		throw new Error(`Kaito API: Tweet not found (status=${data.status})`);
	}

	const tweet = data.tweets[0];
	const media = extractTweetMedia(tweet);
	const ogImageUrl = media[0]?.url ?? null;
	const expandedUrls = extractExpandedUrls(tweet);
	const tweetText = stripTweetUrls(tweet.text);

	const articleUrl = findTwitterArticleUrl(expandedUrls, tweet.url);
	const externalUrl = findExternalUrl(expandedUrls);

	if (articleUrl || !externalUrl) {
		if (articleUrl) console.info({ tag: 'TWITTER', msg: 'Detected Twitter Article', articleUrl });
		const articleContent = await scrapeTwitterArticle(tweetId, apiKey);
		if (articleContent) return articleContent;
		if (articleUrl) throw new Error('Twitter Article API failed');
	}

	if (externalUrl) return scrapeExternalLinkTweet(tweet, externalUrl, media, tweetText, ogImageUrl);

	const title = buildTweetTitle(tweet, 80);

	console.info({ tag: 'TWITTER', msg: 'Tweet fetched', userName: tweet.author?.userName });

	return {
		sourceUrl: tweet.url,
		contentType: 'text/markdown',
		title,
		markdown: tweet.text,
		text: tweet.text,
		metadata: {
			author: tweet.author?.userName || null,
			publishedDate: tweet.createdAt,
			siteName: 'Twitter',
			description: tweet.text,
			ogImageUrl: ogImageUrl || tweet.author?.profilePicture || null,
		},
		status: tweet.text.trim().length > 0 ? 'ok' : 'failed',
		platformMetadata: buildTweetPlatformMetadata(tweet, externalUrl ? { externalUrl, tweetText } : {}),
	};
}
