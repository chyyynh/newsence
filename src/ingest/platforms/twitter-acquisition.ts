import { fetchWithTimeout, readTextWithLimit } from '@core-shared/http';
import type {
	NormalizedContent,
	PlatformMetadata,
	QuotedTweetData,
	RetweetedByData,
	TwitterAuthorFields,
	TwitterMedia,
} from '@core-shared/types';
import { extractTweetId } from '@core-shared/url';

// twitterapi.io tweet response shape used inside the Twitter platform only.
export interface Tweet {
	id?: string;
	url: string;
	createdAt: string;
	viewCount?: number;
	author?: {
		id?: string;
		userName: string;
		name: string;
		profilePicture?: string;
		isBlueVerified?: boolean;
	};
	text: string;
	likeCount?: number;
	retweetCount?: number;
	replyCount?: number;
	quoteCount?: number;
	extendedEntities?: {
		media?: Array<{
			media_url_https: string;
			type: string;
			sizes?: { large?: { w: number; h: number } };
			video_info?: { variants?: Array<{ bitrate?: number; content_type?: string; url: string }> };
		}>;
	};
	hashTags?: string[];
	urls?: Array<{ expanded_url?: string; url?: string }>;
	entities?: { urls?: Array<{ expanded_url?: string; url?: string }> };
	lang?: string;
	conversationId?: string;
	isReply?: boolean;
	inReplyToId?: string | null;
	inReplyToUsername?: string | null;
	quoted_tweet?: Tweet | null;
	retweeted_tweet?: Tweet | null;
	retweetedBy?: RetweetedByData;
}

type AuthoredTweet = Tweet & { author: NonNullable<Tweet['author']> };

function requiredTweetAuthor(tweet: Tweet): NonNullable<Tweet['author']> {
	if (!tweet.author?.userName.trim() || !tweet.author.name.trim()) {
		throw new Error(`Tweet ${tweet.id ?? tweet.url} has no complete author`);
	}
	return tweet.author;
}

const NON_RESOURCE_LINK_HOSTS = new Set(['twitter.com', 'x.com', 'instagram.com', 'tiktok.com', 'facebook.com', 'threads.net']);

function isNonResourceLinkUrl(url: string): boolean {
	let hostname: string;
	try {
		hostname = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (hostname.startsWith('www.')) hostname = hostname.slice(4);
	for (const host of NON_RESOURCE_LINK_HOSTS) {
		if (hostname === host || hostname.endsWith(`.${host}`)) return true;
	}
	return false;
}

function extractTweetAuthor(tweet: Tweet): TwitterAuthorFields {
	const author = requiredTweetAuthor(tweet);
	return {
		authorName: author.name,
		authorUserName: author.userName,
		authorProfilePicture: author.profilePicture,
		authorVerified: author.isBlueVerified,
	};
}

function extractTweetMedia(tweet: Tweet): TwitterMedia[] {
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
					.filter((v): v is typeof v & { bitrate: number } => v.content_type === 'video/mp4' && Number.isFinite(v.bitrate))
					.sort((a, b) => b.bitrate - a.bitrate)[0];
				if (mp4) result.videoUrl = mp4.url;
			}
			return [result];
		}) ?? []
	);
}

function tweetUrlEntities(tweet: Tweet): Array<{ expanded_url?: string; url?: string }> {
	return tweet.urls ?? tweet.entities?.urls ?? [];
}

function extractExpandedUrls(tweet: Tweet): string[] {
	return tweetUrlEntities(tweet).flatMap((url) => {
		const expandedUrl = url.expanded_url?.trim();
		return expandedUrl ? [expandedUrl] : [];
	});
}

const TCO_TOKEN_RE = /https?:\/\/t\.co\/[A-Za-z0-9]+/g;

function isTweetMediaPageUrl(url: string): boolean {
	return /\/status\/\d+\/(?:photo|video)\/\d+/.test(url);
}

/**
 * Rewrite tweet text the way Twitter renders it: each t.co token becomes its
 * expanded URL. Tokens are dropped when Twitter hides them — media links
 * (expansions pointing at the tweet's own photo/video pages, or t.co with no
 * url entity at all) and a trailing link to the quoted tweet (the quote box
 * renders instead).
 */
function expandTweetUrls(text: string, tweet: Tweet): string {
	const replacements = new Map<string, string>();
	for (const entity of tweetUrlEntities(tweet)) {
		const token = entity.url?.trim();
		const expanded = entity.expanded_url?.trim();
		if (!token || !expanded) continue;
		replacements.set(token, isTweetMediaPageUrl(expanded) ? '' : expanded);
	}
	const quoted = tweet.quoted_tweet;
	const quotedTweetId = quoted ? quoted.id?.trim() || extractTweetId(quoted.url) : null;
	const trailing = text.match(/(https?:\/\/\S+)\s*$/)?.[1];
	if (quotedTweetId && trailing) {
		const expandedTrailing = replacements.get(trailing) ?? trailing;
		if (extractTweetId(expandedTrailing) === quotedTweetId) replacements.set(trailing, '');
	}
	return collapseRemovedUrlGaps(text.replace(TCO_TOKEN_RE, (token) => replacements.get(token) ?? ''));
}

/** Expand mapped t.co tokens only — for longform bodies, where unmapped t.co are the article's own links. */
function expandKnownTweetUrls(text: string, tweet: Tweet): string {
	const replacements = new Map<string, string>();
	for (const entity of tweetUrlEntities(tweet)) {
		const token = entity.url?.trim();
		const expanded = entity.expanded_url?.trim();
		if (token && expanded) replacements.set(token, expanded);
	}
	return text.replace(TCO_TOKEN_RE, (token) => replacements.get(token) ?? token);
}

function collapseRemovedUrlGaps(text: string): string {
	return text
		.replace(/[^\S\n]+\n/g, '\n')
		.replace(/[^\S\n]{2,}/g, ' ')
		.trim();
}

function stripTweetUrls(text: string): string {
	return text.replace(/https?:\/\/\S+/g, '').trim();
}

function extractQuotedTweet(tweet: Tweet): QuotedTweetData | undefined {
	const q = tweet.quoted_tweet;
	if (!q) return undefined;
	const authorName = q.author?.name?.trim();
	const authorUserName = q.author?.userName?.trim();
	const text = typeof q.text === 'string' ? expandTweetUrls(q.text, q) : '';
	if (!authorName || !authorUserName || !text) return undefined;
	return {
		authorName,
		authorUserName,
		authorProfilePicture: q.author?.profilePicture,
		text,
	};
}

function findTwitterLongformUrl(urls: string[], tweetUrl?: string): string | undefined {
	return [tweetUrl, ...urls].find((u) => u && /(?:twitter\.com|x\.com)\/i\/article\//.test(u));
}

function findLinkedContentUrl(urls: string[]): string | undefined {
	return urls.find((u) => !/(?:t\.co)/.test(u) && !isNonResourceLinkUrl(u));
}

export function buildTweetTitle(tweet: Tweet, maxLength = 100): string {
	const author = requiredTweetAuthor(tweet);
	// Titles are display/search strings: drop URLs entirely (expanded ones would
	// blow the length cap); URL-only tweets fall back to the raw text.
	const text = stripTweetUrls(tweet.text) || tweet.text.trim();
	if (!text) throw new Error(`Tweet ${tweet.id ?? tweet.url} has no text`);
	const suffix = text.length > maxLength ? '...' : '';
	return `@${author.userName}: ${text.substring(0, maxLength)}${suffix}`;
}

export function buildThreadResourceParts(tweets: Tweet[]): {
	first: AuthoredTweet;
	combinedText: string;
	platformMetadata: PlatformMetadata<'twitter'>;
} {
	const sorted = [...tweets].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
	const firstTweet = sorted[0];
	if (!firstTweet) throw new Error('Cannot build twitter thread resource from empty tweets');
	const first: AuthoredTweet = { ...firstTweet, author: requiredTweetAuthor(firstTweet) };

	const seen = new Set<string>();
	const uniqueTexts: string[] = [];
	for (const tweet of sorted) {
		const text = expandTweetUrls(tweet.text, tweet);
		if (text && !seen.has(text)) {
			seen.add(text);
			uniqueTexts.push(text);
		}
	}

	const media = sorted.flatMap(extractTweetMedia);
	const quotedTweet = sorted.map(extractQuotedTweet).find(Boolean);
	const platformMetadata = buildTweetPlatformMetadata(first, { media, quotedTweet });
	return {
		first,
		combinedText: uniqueTexts.join('\n\n'),
		platformMetadata,
	};
}

function buildTweetPlatformMetadata(
	tweet: Tweet,
	options: {
		externalUrl?: string;
		media?: TwitterMedia[];
		quotedTweet?: QuotedTweetData;
	} = {},
): PlatformMetadata<'twitter'> {
	const media = options.media ?? extractTweetMedia(tweet);
	const base = {
		tweetId: tweet.id,
		...extractTweetAuthor(tweet),
		media,
		createdAt: tweet.createdAt,
	};

	if (options.externalUrl) {
		return {
			fetchedAt: new Date().toISOString(),
			data: {
				...base,
				externalUrl: options.externalUrl,
			},
		};
	}

	return {
		fetchedAt: new Date().toISOString(),
		data: { ...base, quotedTweet: options.quotedTweet ?? extractQuotedTweet(tweet) },
	};
}

function buildTwitterLongformPlatformMetadata(
	tweetId: string,
	author: NonNullable<TwitterLongform['author']>,
	coverImageUrl?: string,
): PlatformMetadata<'twitter'> {
	return {
		fetchedAt: new Date().toISOString(),
		data: {
			tweetId,
			authorName: author.name,
			authorUserName: author.userName,
			authorProfilePicture: author.profilePicture,
			authorVerified: author.isBlueVerified,
			coverImageUrl,
			media: coverImageUrl ? [{ url: coverImageUrl, type: 'photo' }] : [],
		},
	};
}

interface TwitterLongform {
	title?: string;
	cover_media_img_url?: string;
	contents?: Array<{ text?: string }>;
	author?: {
		userName: string;
		name: string;
		isBlueVerified?: boolean;
		profilePicture?: string;
	};
	createdAt?: string;
}

async function scrapeTwitterLongform(
	tweetId: string,
	apiKey: string,
	language?: string,
): Promise<NormalizedContent<'twitter'> & { platformMetadata: PlatformMetadata<'twitter'> }> {
	console.info({ tag: 'TWITTER', msg: 'Fetching longform for tweet', tweetId });

	const response = await fetchWithTimeout(`https://api.twitterapi.io/twitter/article?tweet_id=${tweetId}`, {
		headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`Twitter longform request failed with HTTP ${response.status}`);
	}
	const data = JSON.parse(await readTextWithLimit(response)) as { article?: TwitterLongform; status?: string };
	if (data.status !== 'success' || !data.article) throw new Error(`Twitter longform response was invalid for ${tweetId}`);

	const longform = data.article;
	if (!Array.isArray(longform.contents) || longform.contents.length === 0) {
		throw new Error(`Twitter longform ${tweetId} requires contents`);
	}
	const contentText = longform.contents
		.map((content, index) => {
			const text = content.text?.trim();
			if (!text) throw new Error(`Twitter longform ${tweetId} has invalid content ${index}`);
			return text;
		})
		.join('\n\n');
	if (!longform.title?.trim() || !contentText) throw new Error(`Twitter longform ${tweetId} requires both title and content`);
	const title = longform.title.trim();
	const author = longform.author;
	if (!author?.name.trim() || !author.userName.trim()) throw new Error(`Twitter longform ${tweetId} requires a complete author`);
	const publishedDate = longform.createdAt?.trim();
	if (!publishedDate || Number.isNaN(new Date(publishedDate).getTime())) {
		throw new Error(`Twitter longform ${tweetId} requires a valid published date`);
	}

	console.info({ tag: 'TWITTER', msg: 'Longform fetched', title });

	return {
		type: 'twitter',
		resourcePlatform: 'twitter',
		fileType: null,
		title,
		markdown: contentText,
		metadata: {
			author: author.userName,
			language: language ?? null,
			publishedDate,
			siteName: 'Twitter',
			description: null,
		},
		previewImageUrl: longform.cover_media_img_url ?? null,
		platformMetadata: buildTwitterLongformPlatformMetadata(tweetId, author, longform.cover_media_img_url),
	};
}

function buildExternalLinkTweet(
	tweet: Tweet,
	externalUrl: string,
	media: TwitterMedia[],
): NormalizedContent<'twitter'> & { platformMetadata: PlatformMetadata<'twitter'> } {
	const author = requiredTweetAuthor(tweet);
	const tweetText = tweet.text.trim();
	if (!tweetText) throw new Error(`Tweet ${tweet.id ?? tweet.url} has no text`);
	const title = `@${author.userName}: ${stripTweetUrls(tweetText) || tweetText}`.slice(0, 120);
	return {
		type: 'twitter',
		resourcePlatform: 'twitter',
		fileType: null,
		title,
		markdown: expandTweetUrls(tweetText, tweet),
		metadata: {
			author: author.userName,
			language: tweet.lang ?? null,
			publishedDate: tweet.createdAt,
			siteName: new URL(externalUrl).hostname.replace(/^www\./, ''),
			description: null,
		},
		platformMetadata: buildTweetPlatformMetadata(tweet, {
			media,
			externalUrl,
		}),
	};
}

export async function resolveTweetContent(tweet: Tweet, apiKey: string) {
	const media = extractTweetMedia(tweet);
	const mediaPreviewImageUrl = media[0]?.url ?? null;
	const expandedUrls = extractExpandedUrls(tweet);
	const tweetText = stripTweetUrls(tweet.text);

	const longformUrl = findTwitterLongformUrl(expandedUrls, tweet.url);
	const linkedContentUrl = findLinkedContentUrl(expandedUrls);

	if (longformUrl) {
		console.info({ tag: 'TWITTER', msg: 'Detected Twitter longform', longformUrl });
		const tweetId = tweet.id?.trim();
		if (!tweetId) throw new Error(`Could not resolve tweet id for longform URL ${longformUrl}`);
		const longformContent = await scrapeTwitterLongform(tweetId, apiKey, tweet.lang);
		const scraped = { ...longformContent, markdown: expandKnownTweetUrls(longformContent.markdown, tweet) };
		return {
			kind: 'longform' as const,
			scraped,
			canonicalUrl: tweet.url,
			eventText: scraped.markdown,
		};
	}

	if (linkedContentUrl) {
		const scraped = {
			...buildExternalLinkTweet(tweet, linkedContentUrl, media),
			previewImageUrl: mediaPreviewImageUrl,
		};
		return { kind: 'share' as const, scraped, canonicalUrl: tweet.url, eventText: tweetText };
	}

	const author = requiredTweetAuthor(tweet);
	const title = buildTweetTitle(tweet, 80);

	console.info({ tag: 'TWITTER', msg: 'Tweet fetched', userName: author.userName });

	return {
		kind: 'tweet' as const,
		scraped: {
			type: 'twitter' as const,
			resourcePlatform: 'twitter' as const,
			fileType: null,
			title,
			markdown: expandTweetUrls(tweet.text, tweet),
			metadata: {
				author: author.userName,
				language: tweet.lang ?? null,
				publishedDate: tweet.createdAt,
				siteName: 'Twitter',
				description: null,
			},
			previewImageUrl: mediaPreviewImageUrl,
			platformMetadata: buildTweetPlatformMetadata(tweet),
		},
		canonicalUrl: tweet.url,
		eventText: tweetText,
	};
}

export async function scrapeTweet(tweetId: string, apiKey: string): Promise<NormalizedContent<'twitter'>> {
	console.info({ tag: 'TWITTER', msg: 'Fetching tweet', tweetId });
	const response = await fetchWithTimeout(`https://api.twitterapi.io/twitter/tweets?tweet_ids=${tweetId}`, {
		headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`HTTP ${response.status}: ${response.statusText}`);
	}
	const data = JSON.parse(await readTextWithLimit(response)) as { tweets?: Tweet[]; status: string; msg?: string };
	if (!Array.isArray(data.tweets)) throw new Error(`Twitter API response omitted tweets (status=${data.status})`);
	const tweet = data.tweets[0];
	if (!tweet) throw new Error(`Twitter API: Tweet not found (status=${data.status})`);
	const resolved = await resolveTweetContent(tweet, apiKey);
	if (resolved.kind !== 'tweet') return resolved.scraped;

	const contextTweets = await fetchTwitterThreadContext(tweetId, apiKey);
	const conversationId = tweet.conversationId || tweet.id;
	const authorUserName = tweet.author?.userName;
	const seen = new Set<string>();
	const thread = [tweet, ...contextTweets].filter((candidate) => {
		const key = candidate.id || candidate.url;
		if (!key || seen.has(key)) return false;
		seen.add(key);
		if (candidate.id === tweet.id) return true;
		return (
			!!conversationId && candidate.conversationId === conversationId && !!authorUserName && candidate.author?.userName === authorUserName
		);
	});
	if (thread.length < 2) return resolved.scraped;

	const parts = buildThreadResourceParts(thread);
	return {
		type: 'twitter',
		resourcePlatform: 'twitter',
		fileType: null,
		title: buildTweetTitle(parts.first, 80),
		markdown: parts.combinedText,
		metadata: {
			author: parts.first.author.userName,
			language: parts.first.lang ?? null,
			publishedDate: parts.first.createdAt,
			siteName: 'Twitter',
			description: null,
		},
		previewImageUrl: parts.platformMetadata.data.media?.[0]?.url ?? null,
		platformMetadata: parts.platformMetadata,
	};
}

async function fetchTwitterThreadContext(tweetId: string, apiKey: string): Promise<Tweet[]> {
	const tweets: Tweet[] = [];
	const seenCursors = new Set<string>();
	let cursor = '';
	for (let page = 0; page < 5; page++) {
		const params = new URLSearchParams({ tweetId });
		if (cursor) params.set('cursor', cursor);
		const response = await fetchWithTimeout(`https://api.twitterapi.io/twitter/tweet/thread_context?${params}`, {
			headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}
		const data = JSON.parse(await readTextWithLimit(response, 2 * 1024 * 1024)) as {
			tweets?: Tweet[];
			has_next_page?: boolean;
			next_cursor?: string;
		};
		if (!Array.isArray(data.tweets)) throw new Error(`Twitter thread context ${tweetId} omitted tweets`);
		tweets.push(...data.tweets);
		if (typeof data.has_next_page !== 'boolean') throw new Error(`Twitter thread context ${tweetId} omitted has_next_page`);
		if (!data.has_next_page) break;
		if (page === 4) throw new Error(`Twitter thread context ${tweetId} exceeded 5 pages`);
		const nextCursor = data.next_cursor?.trim();
		if (!nextCursor) throw new Error(`Twitter thread context ${tweetId} omitted the next cursor`);
		cursor = nextCursor;
		if (seenCursors.has(cursor)) throw new Error(`Twitter thread context ${tweetId} returned a repeated cursor`);
		seenCursors.add(cursor);
		await scheduler.wait(250);
	}
	return tweets;
}
