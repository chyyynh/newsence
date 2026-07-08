import { generateObject } from '@core-ai/embedding';
import {
	type Article,
	ENTITY_TYPES,
	type NormalizedContent,
	type PlatformMetadata,
	type QuotedTweetData,
	type RetweetedByData,
	type TwitterAuthorFields,
	type TwitterMedia,
} from '@core-shared/types';
import { fetchWithTimeout, normalizeUrl, readTextWithLimit } from '@core-shared/web';
import { entityExtractionExclusionNames } from '@entities/normalize';
import { getExistingArticlesByUrl, reopenArticleForReprocessing } from '@ingest/domain/article-store';
import { enqueueProcessing } from '@ingest/workflow';
import { Client } from 'pg';
import { z } from 'zod';
import { generateArticleAnalysis, isEmpty, mergeArticleAnalysis, type ProcessorResult } from '../domain/ai-utils';

// twitterapi.io tweet response shape used inside the Twitter platform only.
interface Tweet {
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

function extractTweetId(url: string): string | null {
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

function findTwitterArticleUrl(urls: string[], tweetUrl?: string): string | undefined {
	return [tweetUrl, ...urls].find((u) => u && /(?:twitter\.com|x\.com)\/i\/article\//.test(u));
}

function findLinkedArticleUrl(urls: string[]): string | undefined {
	return urls.find((u) => !/(?:t\.co)/.test(u) && !isNonArticleLinkUrl(u));
}

function buildTweetTitle(tweet: Tweet, maxLength = 100): string {
	const suffix = tweet.text.length > maxLength ? '...' : '';
	const author = tweet.author?.userName ? `@${tweet.author.userName}` : 'Twitter';
	return `${author}: ${tweet.text.substring(0, maxLength)}${suffix}`;
}

function buildThreadArticleParts<T extends Tweet>(
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

function buildTweetPlatformMetadata(
	tweet: Tweet,
	options: {
		externalUrl?: string;
		externalOgImage?: string | null;
		externalTitle?: string | null;
		originalTweetUrl?: string;
		tweetText?: string;
		media?: TwitterMedia[];
		quotedTweet?: QuotedTweetData;
	} = {},
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
): Promise<(NormalizedContent & { platformMetadata: Extract<PlatformMetadata, { type: 'twitter' }> }) | null> {
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
		title,
		markdown: md,
		metadata: {
			author: article.author?.userName || null,
			publishedDate: article.createdAt || null,
			siteName: 'Twitter',
			description: summary,
			ogImageUrl: article.cover_media_img_url || article.author?.profilePicture || null,
		},
		platformMetadata: buildTwitterArticlePlatformMetadata(tweetId, article.author),
	};
}

function buildExternalLinkTweet(
	tweet: Tweet,
	externalUrl: string,
	media: TwitterMedia[],
	tweetText: string,
	ogImageUrl: string | null,
): NormalizedContent & { platformMetadata: Extract<PlatformMetadata, { type: 'twitter' }> } {
	const title = `@${tweet.author?.userName}: ${tweetText || tweet.text}`.slice(0, 120);
	return {
		title,
		markdown: tweetText || tweet.text,
		metadata: {
			author: tweet.author?.userName || null,
			publishedDate: tweet.createdAt,
			siteName: new URL(externalUrl).hostname.replace(/^www\./, ''),
			description: tweetText || tweet.text,
			ogImageUrl: ogImageUrl || tweet.author?.profilePicture || null,
		},
		platformMetadata: buildTweetPlatformMetadata(tweet, {
			media,
			tweetText,
			externalUrl,
			externalOgImage: ogImageUrl,
			externalTitle: null,
			originalTweetUrl: tweet.url,
		}),
	};
}

async function resolveTweetContent(tweet: Tweet, apiKey: string) {
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
				kind: 'article' as const,
				scraped: articleContent,
				canonicalUrl: tweet.url || `https://x.com/i/status/${tweetId}`,
				eventText: articleContent.metadata.description || tweetText,
			};
		}
		if (articleUrl) throw new Error('Twitter Article API failed');
	}

	if (linkedArticleUrl) {
		const scraped = buildExternalLinkTweet(tweet, linkedArticleUrl, media, tweetText, ogImageUrl);
		return { kind: 'share' as const, scraped, canonicalUrl: linkedArticleUrl, eventText: tweetText };
	}

	const title = buildTweetTitle(tweet, 80);

	console.info({ tag: 'TWITTER', msg: 'Tweet fetched', userName: tweet.author?.userName });

	return {
		kind: 'tweet' as const,
		scraped: {
			title,
			markdown: tweet.text,
			metadata: {
				author: tweet.author?.userName || null,
				publishedDate: tweet.createdAt,
				siteName: 'Twitter',
				description: tweet.text,
				ogImageUrl: ogImageUrl || tweet.author?.profilePicture || null,
			},
			platformMetadata: buildTweetPlatformMetadata(tweet),
		},
		canonicalUrl: tweet.url,
		eventText: tweetText,
	};
}

async function enqueueTwitterArticle(
	env: CoreEnv,
	data: {
		url: string;
		title: string;
		source: string;
		publishedDate: Date;
		summary: string;
		content: string | null;
		platformMetadata: PlatformMetadata;
		hashTags?: string[];
	},
): Promise<boolean> {
	await enqueueProcessing(env, {
		kind: 'source',
		draft: {
			article: {
				url: data.url,
				title: data.title,
				source: data.source,
				publishedDate: data.publishedDate,
				summary: data.summary,
				sourceType: 'twitter',
				content: data.content,
				platformMetadata: data.platformMetadata,
				keywords: data.hashTags,
			},
		},
	});
	return true;
}

const MIN_TWEET_LENGTH = 150;

async function saveTweet(db: Client, tweet: Tweet, env: CoreEnv): Promise<boolean> {
	const resolved = await resolveTweetContent(tweet, env.KAITO_API_KEY).catch((err) => {
		console.warn({ tag: 'TWITTER', msg: 'Tweet content resolution failed', url: tweet.url, error: String(err) });
		return null;
	});
	if (!resolved) return false;

	if (resolved.kind === 'tweet' && !tweet.retweetedBy && resolved.eventText.length < MIN_TWEET_LENGTH) {
		console.info({ tag: 'TWITTER', msg: 'Filtered tweet', author: tweet.author?.userName, reason: 'too short standalone tweet' });
		return false;
	}

	const articleUrl = normalizeUrl(resolved.canonicalUrl);
	const [existingArticle] = await getExistingArticlesByUrl(db, [articleUrl]);
	if (existingArticle) {
		if (!existingArticle.summary_cn) await enqueueProcessing(env, { kind: 'stored', table: 'articles', rowId: existingArticle.id });
		console.info({ tag: 'TWITTER', msg: 'Article already exists (dedup)', url: articleUrl, eventType: resolved.kind });
		return true;
	}

	const { scraped } = resolved;
	const title = scraped.title || buildTweetTitle(tweet);
	const source =
		resolved.kind === 'share'
			? scraped.metadata.siteName || scraped.metadata.author || 'External'
			: tweet.author?.name || scraped.metadata.author || 'Twitter';
	const queued = await enqueueTwitterArticle(env, {
		url: articleUrl,
		title,
		source,
		publishedDate: new Date(scraped.metadata.publishedDate || tweet.createdAt),
		summary: resolved.kind === 'tweet' ? resolved.eventText : scraped.metadata.description || '',
		content: resolved.kind === 'tweet' ? resolved.eventText || null : scraped.markdown,
		platformMetadata: scraped.platformMetadata,
		hashTags: tweet.hashTags,
	});
	if (queued) console.info({ tag: 'TWITTER', msg: 'Saved tweet content', kind: resolved.kind, title: title.slice(0, 50) });
	return queued;
}

async function saveThread(db: Client, tweets: Tweet[], env: CoreEnv): Promise<boolean> {
	const { first, combinedText, platformMetadata } = buildThreadArticleParts(tweets);
	const firstUrl = normalizeUrl(first.url);
	const tweetCount = tweets.length;

	const [existing] = await getExistingArticlesByUrl(db, [firstUrl]);

	if (existing) {
		const existingId = existing.id;
		await reopenArticleForReprocessing(db, existingId, { summary: combinedText, content: combinedText, platformMetadata });
		await enqueueProcessing(env, { kind: 'stored', table: 'articles', rowId: existingId });
		console.info({ tag: 'TWITTER', msg: 'Updated thread', author: first.author?.userName, tweets: tweetCount });
		return true;
	}

	const queued = await enqueueTwitterArticle(env, {
		url: firstUrl,
		title: buildTweetTitle(first),
		source: first.author?.name || 'Twitter',
		publishedDate: new Date(first.createdAt),
		summary: combinedText,
		content: combinedText,
		platformMetadata,
		hashTags: first.hashTags,
	});

	if (queued) {
		console.info({ tag: 'TWITTER', msg: 'Saved thread', author: first.author?.userName, tweets: tweetCount });
	}
	return queued;
}

// Twitter Monitor

const TWITTER_ADVANCED_SEARCH_API = 'https://api.twitterapi.io/twitter/tweet/advanced_search';

/** Max usernames per query batch to stay within query length limits */
const TWITTER_BATCH_SIZE = 20;
const TWITTER_MAX_PAGES_PER_BATCH = 5;
const TWITTER_USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;
const TWITTER_NON_PROFILE_PATHS = new Set(['home', 'i', 'intent', 'search', 'share']);
const SOURCE_FEED_FIELDS = 'id, "RSSLink", scraped_at';

function normalizeRetweet(tweet: Tweet): Tweet | null {
	if (tweet.retweeted_tweet) {
		return {
			...tweet.retweeted_tweet,
			retweetedBy: {
				tweetId: tweet.id,
				tweetUrl: tweet.url,
				retweetedAt: tweet.createdAt,
				authorName: tweet.author?.name || '',
				authorUserName: tweet.author?.userName || '',
				authorProfilePicture: tweet.author?.profilePicture,
				authorVerified: tweet.author?.isBlueVerified,
			},
		};
	}
	if (tweet.text.startsWith('RT @')) return null;
	return tweet;
}

function normalizeTwitterUserName(input: string | null | undefined): string | null {
	const trimmed = input?.trim();
	if (!trimmed) return null;

	let candidate = trimmed.replace(/^@/, '');
	try {
		const url = new URL(trimmed);
		if (!/(^|\.)x\.com$|(^|\.)twitter\.com$/.test(url.hostname.toLowerCase())) return null;
		candidate = url.pathname.split('/').filter(Boolean)[0] ?? '';
		if (TWITTER_NON_PROFILE_PATHS.has(candidate.toLowerCase())) return null;
	} catch {
		// Plain handle input.
	}

	const userName = candidate.replace(/^@/, '').trim();
	return TWITTER_USERNAME_RE.test(userName) ? userName : null;
}

/**
 * Global sinceTime = oldest scraped_at across all users minus a 1h overlap.
 * If no user has been scraped before, fall back to 24h ago.
 */
function calculateMonitoringSinceTime(users: Array<{ scraped_at?: string | null }>): number {
	if (!users.some((u) => u.scraped_at)) {
		return Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
	}
	const oldest = users.reduce((min, u) => {
		if (!u.scraped_at) return min;
		const t = new Date(u.scraped_at).getTime();
		return t < min ? t : min;
	}, Date.now());
	return Math.floor((oldest - 60 * 60 * 1000) / 1000);
}

/** Fetch all tweets matching `(from:u1 OR from:u2 …) since_time:<unix>`, paginating through cursors. */
async function fetchTweetsForBatch(
	apiKey: string,
	userNames: string[],
	sinceTime: number,
): Promise<{ tweets: Tweet[]; completed: boolean }> {
	const fromClause = userNames.map((u) => `from:${u}`).join(' OR ');
	const query = `(${fromClause}) since_time:${sinceTime}`;

	const tweets: Tweet[] = [];
	let cursor = '';
	let pages = 0;

	while (true) {
		pages++;
		const params = new URLSearchParams({ query, queryType: 'Latest' });
		if (cursor) params.set('cursor', cursor);

		let apiRes: { tweets?: Tweet[]; has_next_page?: boolean; next_cursor?: string };
		try {
			const response = await fetchWithTimeout(
				`${TWITTER_ADVANCED_SEARCH_API}?${params}`,
				{ headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' } },
				20_000,
			);
			if (!response.ok) {
				await response.body?.cancel();
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}
			apiRes = JSON.parse(await readTextWithLimit(response, 2 * 1024 * 1024)) as {
				tweets?: Tweet[];
				has_next_page?: boolean;
				next_cursor?: string;
			};
		} catch (err) {
			console.error({ tag: 'TWITTER', msg: 'Advanced Search fetch failed', error: String(err) });
			return { tweets, completed: false };
		}
		for (const tweet of apiRes.tweets || []) {
			const normalized = normalizeRetweet(tweet);
			if (normalized) tweets.push(normalized);
		}

		if (!apiRes.has_next_page) break;
		if (pages >= TWITTER_MAX_PAGES_PER_BATCH) {
			console.warn({ tag: 'TWITTER', msg: 'Advanced Search page cap reached', users: userNames.length, sinceTime, pages });
			return { tweets, completed: false };
		}
		cursor = apiRes.next_cursor || '';
		if (!cursor) break;
		await scheduler.wait(1000);
	}

	return { tweets, completed: true };
}

/**
 * Group tweets by conversation so threads can be saved as a single merged article.
 * Root tweets + self-replies in the same conversation merge; orphan self-replies
 * (reply targets we didn't fetch) get saved as standalone tweets.
 */
function groupTweetsIntoThreads(tweets: Tweet[]): Tweet[][] {
	const rootTweets = tweets.filter((t) => !t.isReply);
	const selfReplies = tweets.filter((t) => t.isReply && t.inReplyToUsername === t.author?.userName);

	const rootConversationIds = new Set(rootTweets.map((t) => t.conversationId || t.id));
	const threadReplies = selfReplies.filter((t) => t.conversationId && rootConversationIds.has(t.conversationId));
	const orphanReplies = selfReplies.filter((t) => !t.conversationId || !rootConversationIds.has(t.conversationId));

	const groups = new Map<string, Tweet[]>();
	for (const tweet of [...rootTweets, ...threadReplies]) {
		const key = tweet.conversationId || tweet.id || tweet.url;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key)!.push(tweet);
	}
	return [...groups.values(), ...orphanReplies.map((tweet) => [tweet])];
}

export async function handleTwitterCron(env: CoreEnv): Promise<void> {
	console.info({ tag: 'TWITTER', msg: 'start' });
	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	const users = (
		await db.query<{ id: string; RSSLink: string | null; scraped_at?: string | null }>(
			`SELECT ${SOURCE_FEED_FIELDS} FROM "RssList" WHERE type = $1`,
			['twitter_user'],
		)
	).rows;
	if (!users.length) {
		console.info({ tag: 'TWITTER', msg: 'No twitter_user source feeds configured' });
		return;
	}

	const monitoredUsers = users.flatMap((user) => {
		const twitterUserName = normalizeTwitterUserName(user.RSSLink);
		return twitterUserName ? [{ ...user, twitterUserName }] : [];
	});
	const userNames = [...new Set(monitoredUsers.map((u) => u.twitterUserName))];
	if (userNames.length === 0) {
		console.warn({ tag: 'TWITTER', msg: 'No valid twitter usernames in source feeds', users: users.length });
		return;
	}
	const sinceTime = calculateMonitoringSinceTime(monitoredUsers);
	const batches: string[][] = [];
	for (let i = 0; i < userNames.length; i += TWITTER_BATCH_SIZE) {
		batches.push(userNames.slice(i, i + TWITTER_BATCH_SIZE));
	}

	console.info({ tag: 'TWITTER', msg: 'Fetching via Advanced Search', users: userNames.length, batches: batches.length, sinceTime });

	let processed = 0;
	let allCompleted = true;
	for (const batch of batches) {
		const { tweets, completed } = await fetchTweetsForBatch(env.KAITO_API_KEY, batch, sinceTime);
		if (!completed) allCompleted = false;
		for (const group of groupTweetsIntoThreads(tweets)) {
			const first = group[0];
			if (!first) continue;
			try {
				const saved = group.length >= 2 ? await saveThread(db, group, env) : await saveTweet(db, first, env);
				if (saved) processed++;
			} catch (err) {
				allCompleted = false;
				console.error({ tag: 'TWITTER', msg: 'Save failed', url: first.url, error: String(err) });
			}
		}
	}

	if (allCompleted) {
		await db.query(`UPDATE "RssList" SET scraped_at = $1 WHERE id = ANY($2)`, [new Date(), monitoredUsers.map((u) => u.id)]);
	}

	console.info({
		tag: 'TWITTER',
		msg: 'end',
		processed,
		users: users.length,
		validUsers: monitoredUsers.length,
		batches: batches.length,
	});
}

export async function processTwitterArticle(article: Article, env: CoreEnv): Promise<ProcessorResult> {
	const updateData: ProcessorResult['updateData'] = {};
	const hasFullContent = !isEmpty(article.content) && article.content!.length > 200;

	if (hasFullContent) {
		console.info({ tag: 'TWITTER-PROCESSOR', msg: 'Processing Twitter Article', title: article.title.slice(0, 50) });
		const analysis = await generateArticleAnalysis(article, env);
		return mergeArticleAnalysis(article, analysis, { updateData });
	}

	const tweetText = article.summary?.trim() || article.content || '';
	if (isEmpty(article.summary)) updateData.summary = tweetText;

	const analysis = await translateTweet(tweetText, article, env);
	if (!analysis) return mergeArticleAnalysis(article, { tags: ['Twitter'] }, { updateData });
	const merged = mergeArticleAnalysis(
		article,
		{
			title_cn: analysis.summary_cn.slice(0, 80),
			summary_cn: analysis.summary_cn,
			content: isEmpty(article.content) ? tweetText : undefined,
			content_cn: analysis.summary_cn,
			tags: analysis.tags,
			keywords: analysis.keywords,
			entities: analysis.entities,
		},
		{ updateData },
	);
	return { updateData: merged.updateData, classificationCategory: merged.classificationCategory };
}

const TweetAnalysisSchema = z.object({
	summary_cn: z.string().min(1),
	tags: z.array(z.string().min(1)),
	keywords: z.array(z.string().min(1)),
	entities: z.array(
		z.object({
			name: z.string().min(1),
			name_cn: z.string().min(1),
			type: z.enum(ENTITY_TYPES),
		}),
	),
});

type TweetAnalysis = z.infer<typeof TweetAnalysisSchema>;

const TWEET_ANALYSIS_SYSTEM_PROMPT = `請將推文直接翻譯成繁體中文，並提供 tags、keywords、entities。

翻譯規則：
- 直接翻譯原文，保持原文的第一人稱或語氣，不要改寫成第三人稱描述
- 不要用「這則推文」、「作者認為」、「該推文提到」等第三角度描述
- 不要使用任何 Markdown 格式
- summary_cn 是忠實翻譯，不是評論或摘要

實體擷取規則：
- 提取重要的具名實體（人物、組織、產品、技術、事件、地點）
- type 只能是 person, organization, product, technology, event, location
- name 用英文或原文慣用名稱；name_cn 用繁體中文，若無慣用中文名則與 name 相同
- 不要把 Twitter/X、作者帳號或發文平台當作實體，除非推文本身就在討論該平台或作者
- 不要提取泛詞、短縮碎片、股票代號或單字母縮寫，例如 AI、X、Go、US、C、RL、PI、$GOOGL
- 模型、產品、活動請使用完整慣用名稱，例如 Claude Opus 4.7、DeepSeek V4、TechCrunch Disrupt 2026
- 如果只能判斷出泛詞、版本碎片或來源名稱，寧可少提取

標籤規則：
- AI相關: AI, MachineLearning, DeepLearning, LLM, GenerativeAI
- 產品相關: Coding, Robotics, SoftwareDevelopment, API
- 產業應用: Tech, Finance, Healthcare, Gaming, Creative
- 事件類型: ProductLaunch, Research, Partnership, Announcement`;

async function translateTweet(tweetText: string, article: Article, env: CoreEnv): Promise<TweetAnalysis | null> {
	console.info({ tag: 'AI', msg: 'Translating tweet', text: tweetText.substring(0, 60) });
	const excludedEntities = entityExtractionExclusionNames(article.source, article.platform_metadata);
	const excludedLine = excludedEntities.length ? `\n實體排除名單: ${excludedEntities.join(', ')}` : '';

	try {
		const result = await generateObject<TweetAnalysis>(
			env.AI,
			`推文來源: ${article.source}${excludedLine}
推文內容：
${tweetText}`,
			{
				schema: TweetAnalysisSchema,
				task: 'tweet-analysis',
				gatewayId: env.AI_GATEWAY_NAME,
				maxTokens: 600,
				systemPrompt: TWEET_ANALYSIS_SYSTEM_PROMPT,
			},
		);
		if (!result) throw new Error('No JSON found');

		return {
			summary_cn: result.summary_cn,
			tags: (result.tags.length ? result.tags : ['Twitter']).slice(0, 5),
			keywords: result.keywords.slice(0, 8),
			entities: Array.isArray(result.entities) ? result.entities.slice(0, 10) : [],
		};
	} catch (error) {
		console.error({ tag: 'AI', msg: 'Tweet translation failed', error: String(error) });
		return null;
	}
}
