import type { PlatformMetadata, QuotedTweetData, TwitterAuthorFields, TwitterMedia } from '@core-shared/platform-metadata';
import type { ScrapedContent, Tweet } from '@core-shared/types';
import { fetchWithTimeout, readTextWithLimit } from '@core-shared/web';
import { scrapeWebPage } from '../web-scraper';

function isTwitterHost(hostname: string): boolean {
	const lower = hostname.toLowerCase();
	return lower === 'twitter.com' || lower.endsWith('.twitter.com') || lower === 'x.com' || lower.endsWith('.x.com');
}

const NON_ARTICLE_LINK_HOSTS = new Set(['twitter.com', 'x.com', 'instagram.com', 'tiktok.com', 'facebook.com', 'threads.net']);

function isNonArticleLinkUrl(url: string): boolean {
	let hostname: string;
	try {
		hostname = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (hostname.startsWith('www.')) hostname = hostname.slice(4);
	for (const host of NON_ARTICLE_LINK_HOSTS) {
		if (hostname === host || hostname.endsWith(`.${host}`)) return true;
	}
	return false;
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

function extractTweetAuthor(tweet: Tweet): TwitterAuthorFields {
	return {
		authorName: tweet.author?.name || '',
		authorUserName: tweet.author?.userName || '',
		authorProfilePicture: tweet.author?.profilePicture,
		authorVerified: tweet.author?.isBlueVerified,
	};
}

export function extractTweetMedia(tweet: Tweet): TwitterMedia[] {
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

function extractExpandedUrls(tweet: Tweet): string[] {
	const urls = tweet.urls ?? tweet.entities?.urls ?? [];
	return urls.map((u) => u.expanded_url || u.url || '').filter(Boolean);
}

export function stripTweetUrls(text: string): string {
	return text.replace(/https?:\/\/\S+/g, '').trim();
}

function extractQuotedTweet(tweet: Tweet): QuotedTweetData | undefined {
	const q = tweet.quoted_tweet;
	if (!q?.text || !q.author) return undefined;
	return {
		authorName: q.author.name || '',
		authorUserName: q.author.userName || '',
		authorProfilePicture: q.author.profilePicture,
		text: stripTweetUrls(q.text),
	};
}

function findTwitterArticleUrl(urls: string[], tweetUrl?: string): string | undefined {
	return [tweetUrl, ...urls].find((u) => u && /(?:twitter\.com|x\.com)\/i\/article\//.test(u));
}

function findLinkedArticleUrl(urls: string[]): string | undefined {
	return urls.find((u) => !/(?:t\.co)/.test(u) && !isNonArticleLinkUrl(u));
}

export function buildTweetTitle(tweet: Tweet, maxLength = 100): string {
	const suffix = tweet.text.length > maxLength ? '...' : '';
	const author = tweet.author?.userName ? `@${tweet.author.userName}` : 'Twitter';
	return `${author}: ${tweet.text.substring(0, maxLength)}${suffix}`;
}

export function buildThreadArticleParts<T extends Tweet>(
	tweets: T[],
): {
	first: T;
	sorted: T[];
	combinedText: string;
	media: TwitterMedia[];
	platformMetadata: Extract<PlatformMetadata, { type: 'twitter' }>;
} {
	const sorted = [...tweets].sort((a, b) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime());
	const first = sorted[0];
	if (!first) throw new Error('Cannot build twitter thread article from empty tweets');

	const seen = new Set<string>();
	const uniqueTexts: string[] = [];
	for (const tweet of sorted.slice(0, 10)) {
		const text = stripTweetUrls(tweet.text);
		if (text && !seen.has(text)) {
			seen.add(text);
			uniqueTexts.push(text);
		}
	}

	const media = sorted.flatMap(extractTweetMedia);
	const quotedTweet = sorted.map(extractQuotedTweet).find(Boolean);
	return {
		first,
		sorted,
		combinedText: uniqueTexts.join('\n\n'),
		media,
		platformMetadata: buildTweetPlatformMetadata(first, { media, quotedTweet }),
	};
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

function buildTweetPlatformMetadata(tweet: Tweet, options: TweetMetadataOptions = {}): Extract<PlatformMetadata, { type: 'twitter' }> {
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

function buildTwitterArticlePlatformMetadata(
	tweetId: string,
	author: Tweet['author'] | undefined,
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

type ResolvedTweetContent = {
	kind: 'tweet' | 'share' | 'article';
	scraped: ScrapedContent & { platformMetadata: Extract<PlatformMetadata, { type: 'twitter' }> };
	canonicalUrl: string;
	eventText: string;
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

async function scrapeTwitterArticle(
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
	tweet: Tweet,
	externalUrl: string,
	media: TwitterMedia[],
	tweetText: string,
	ogImageUrl: string | null,
): Promise<ScrapedContent & { platformMetadata: Extract<PlatformMetadata, { type: 'twitter' }> }> {
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
				author: linked.metadata.author || tweet.author?.userName || null,
				publishedDate: linked.metadata.publishedDate || tweet.createdAt,
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

export async function resolveTweetContent(tweet: Tweet, apiKey: string): Promise<ResolvedTweetContent> {
	const media = extractTweetMedia(tweet);
	const ogImageUrl = media[0]?.url ?? null;
	const expandedUrls = extractExpandedUrls(tweet);
	const tweetText = stripTweetUrls(tweet.text);

	const articleUrl = findTwitterArticleUrl(expandedUrls, tweet.url);
	const linkedArticleUrl = findLinkedArticleUrl(expandedUrls);

	if (articleUrl || expandedUrls.length === 0) {
		if (articleUrl) console.info({ tag: 'TWITTER', msg: 'Detected Twitter Article', articleUrl });
		const tweetId = tweet.id ?? extractTweetId(tweet.url);
		const articleContent = tweetId ? await scrapeTwitterArticle(tweetId, apiKey) : null;
		if (articleContent) {
			return {
				kind: 'article',
				scraped: articleContent,
				canonicalUrl: tweet.url || articleContent.sourceUrl || `https://x.com/i/status/${tweetId}`,
				eventText: articleContent.metadata.description || tweetText,
			};
		}
		if (articleUrl) throw new Error('Twitter Article API failed');
	}

	if (linkedArticleUrl) {
		const scraped = await scrapeExternalLinkTweet(tweet, linkedArticleUrl, media, tweetText, ogImageUrl);
		return { kind: 'share', scraped, canonicalUrl: linkedArticleUrl, eventText: tweetText };
	}

	const title = buildTweetTitle(tweet, 80);

	console.info({ tag: 'TWITTER', msg: 'Tweet fetched', userName: tweet.author?.userName });

	return {
		kind: 'tweet',
		scraped: {
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
			platformMetadata: buildTweetPlatformMetadata(tweet),
		},
		canonicalUrl: tweet.url,
		eventText: tweetText,
	};
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
	const data = JSON.parse(await readTextWithLimit(response)) as { tweets?: Tweet[]; status: string; msg?: string };
	if (!data.tweets?.length) {
		throw new Error(`Kaito API: Tweet not found (status=${data.status})`);
	}

	return (await resolveTweetContent(data.tweets[0], apiKey)).scraped;
}
