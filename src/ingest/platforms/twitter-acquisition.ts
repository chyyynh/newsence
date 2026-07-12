import { fetchWithTimeout, readTextWithLimit } from '@core-shared/http';
import type {
	NormalizedContent,
	PlatformMetadata,
	QuotedTweetData,
	RetweetedByData,
	TwitterAuthorFields,
	TwitterMedia,
} from '@core-shared/types';

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

function isTwitterHost(hostname: string): boolean {
	const lower = hostname.toLowerCase();
	return lower === 'twitter.com' || lower.endsWith('.twitter.com') || lower === 'x.com' || lower.endsWith('.x.com');
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

function stripTweetUrls(text: string): string {
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

function findTwitterLongformUrl(urls: string[], tweetUrl?: string): string | undefined {
	return [tweetUrl, ...urls].find((u) => u && /(?:twitter\.com|x\.com)\/i\/article\//.test(u));
}

function findLinkedContentUrl(urls: string[]): string | undefined {
	return urls.find((u) => !/(?:t\.co)/.test(u) && !isNonResourceLinkUrl(u));
}

export function buildTweetTitle(tweet: Tweet, maxLength = 100): string {
	const suffix = tweet.text.length > maxLength ? '...' : '';
	const author = tweet.author?.userName ? `@${tweet.author.userName}` : 'Twitter';
	return `${author}: ${tweet.text.substring(0, maxLength)}${suffix}`;
}

export function buildThreadResourceParts(tweets: Tweet[]): {
	first: Tweet;
	combinedText: string;
	platformMetadata: PlatformMetadata<'twitter'>;
} {
	const sorted = [...tweets].sort((a, b) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime());
	const first = sorted[0];
	if (!first) throw new Error('Cannot build twitter thread resource from empty tweets');

	const seen = new Set<string>();
	const uniqueTexts: string[] = [];
	for (const tweet of sorted) {
		const text = stripTweetUrls(tweet.text);
		if (text && !seen.has(text)) {
			seen.add(text);
			uniqueTexts.push(text);
		}
	}

	const media = sorted.flatMap(extractTweetMedia);
	const quotedTweet = sorted.map(extractQuotedTweet).find(Boolean);
	const platformMetadata = buildTweetPlatformMetadata(first, { media, quotedTweet });
	platformMetadata.data.threadTweetCount = sorted.length;
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
		originalTweetUrl?: string;
		tweetText?: string;
		media?: TwitterMedia[];
		quotedTweet?: QuotedTweetData;
	} = {},
): PlatformMetadata<'twitter'> {
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
			fetchedAt: new Date().toISOString(),
			data: {
				variant: 'shared',
				...base,
				tweetText,
				externalUrl: options.externalUrl,
				originalTweetUrl: options.originalTweetUrl,
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
	author: Tweet['author'] | undefined,
	coverImageUrl?: string,
): PlatformMetadata<'twitter'> {
	return {
		fetchedAt: new Date().toISOString(),
		data: {
			variant: 'longform',
			tweetId,
			authorName: author?.name ?? '',
			authorUserName: author?.userName ?? '',
			authorProfilePicture: author?.profilePicture,
			authorVerified: author?.isBlueVerified,
			media: coverImageUrl ? [{ url: coverImageUrl, type: 'photo' }] : [],
		},
	};
}

interface TwitterLongform {
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
	const contentText = (longform.contents ?? [])
		.map((c) => c.text ?? c.content ?? '')
		.filter(Boolean)
		.join('\n\n');
	if (!longform.title?.trim() || !contentText) throw new Error(`Twitter longform ${tweetId} requires both title and content`);
	const title = longform.title.trim();

	let md = `# ${title}\n\n`;
	if (longform.author) {
		md += `**Author:** ${longform.author.name || longform.author.userName}`;
		if (longform.author.isBlueVerified) md += ' ✓';
		if (longform.author.userName) md += ` (@${longform.author.userName})`;
		md += '\n\n';
	}
	if (longform.cover_media_img_url) md += `![Cover](${longform.cover_media_img_url})\n\n`;
	md += `${contentText}\n\n---\n\n**Engagement:**\n`;
	if (longform.viewCount !== undefined) md += `- Views: ${longform.viewCount.toLocaleString()}\n`;
	if (longform.likeCount !== undefined) md += `- Likes: ${longform.likeCount.toLocaleString()}\n`;
	if (longform.replyCount !== undefined) md += `- Replies: ${longform.replyCount.toLocaleString()}\n`;

	console.info({ tag: 'TWITTER', msg: 'Longform fetched', title });

	return {
		type: 'twitter',
		title,
		markdown: md,
		metadata: {
			author: longform.author?.userName || null,
			language: language ?? null,
			publishedDate: longform.createdAt || null,
			siteName: 'Twitter',
			description: longform.preview_text?.trim() || null,
		},
		previewImageUrl: longform.cover_media_img_url ?? null,
		platformMetadata: buildTwitterLongformPlatformMetadata(tweetId, longform.author, longform.cover_media_img_url),
	};
}

function buildExternalLinkTweet(
	tweet: Tweet,
	externalUrl: string,
	media: TwitterMedia[],
	tweetText: string,
): NormalizedContent<'twitter'> & { platformMetadata: PlatformMetadata<'twitter'> } {
	const title = `@${tweet.author?.userName}: ${tweetText || tweet.text}`.slice(0, 120);
	return {
		type: 'twitter',
		title,
		markdown: tweetText || tweet.text,
		metadata: {
			author: tweet.author?.userName || null,
			language: tweet.lang ?? null,
			publishedDate: tweet.createdAt,
			siteName: new URL(externalUrl).hostname.replace(/^www\./, ''),
			description: tweetText || tweet.text,
		},
		platformMetadata: buildTweetPlatformMetadata(tweet, {
			media,
			tweetText,
			externalUrl,
			originalTweetUrl: tweet.url,
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
		const tweetId = tweet.id ?? extractTweetId(tweet.url);
		if (!tweetId) throw new Error(`Could not resolve tweet id for longform URL ${longformUrl}`);
		const longformContent = await scrapeTwitterLongform(tweetId, apiKey, tweet.lang);
		return {
			kind: 'longform' as const,
			scraped: longformContent,
			canonicalUrl: tweet.url,
			eventText: longformContent.markdown,
		};
	}

	if (linkedContentUrl) {
		const scraped = {
			...buildExternalLinkTweet(tweet, linkedContentUrl, media, tweetText),
			previewImageUrl: mediaPreviewImageUrl,
		};
		return { kind: 'share' as const, scraped, canonicalUrl: tweet.url, eventText: tweetText };
	}

	const title = buildTweetTitle(tweet, 80);

	console.info({ tag: 'TWITTER', msg: 'Tweet fetched', userName: tweet.author?.userName });

	return {
		kind: 'tweet' as const,
		scraped: {
			type: 'twitter' as const,
			title,
			markdown: tweet.text,
			metadata: {
				author: tweet.author?.userName || null,
				language: tweet.lang ?? null,
				publishedDate: tweet.createdAt,
				siteName: 'Twitter',
				description: tweet.text,
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
	const tweet = data.tweets?.[0];
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
		title: buildTweetTitle(parts.first, 80),
		markdown: parts.combinedText,
		metadata: {
			author: parts.first.author?.userName || null,
			language: parts.first.lang ?? null,
			publishedDate: parts.first.createdAt,
			siteName: 'Twitter',
			description: parts.combinedText,
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
		tweets.push(...(data.tweets ?? []));
		if (!data.has_next_page) break;
		cursor = data.next_cursor ?? '';
		if (!cursor || seenCursors.has(cursor)) break;
		seenCursors.add(cursor);
		await scheduler.wait(250);
	}
	return tweets;
}
