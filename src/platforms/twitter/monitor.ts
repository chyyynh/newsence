import type { Client } from 'pg';
import { ARTICLES_TABLE, createDbClient, enqueueArticleProcess, insertArticle } from '../../infra/db';
import { fetchWithTimeout } from '../../infra/fetch';
import { logError, logInfo, logWarn } from '../../infra/log';
import { isSocialMediaUrl, normalizeUrl, resolveUrl } from '../../infra/web';
import type { PlatformMetadata, QuotedTweetData, TwitterMedia } from '../../models/platform-metadata';
import { buildTwitterArticle, buildTwitterShared, buildTwitterStandard } from '../../models/platform-metadata';
import type { Env, ExecutionContext, RSSFeed, Tweet } from '../../models/types';
import { scrapeWebPage } from '../web/scraper';
import { scrapeTwitterArticle } from './scraper';

// ─────────────────────────────────────────────────────────────
// Twitter Monitor
// ─────────────────────────────────────────────────────────────

const TWITTER_ADVANCED_SEARCH_API = 'https://api.twitterapi.io/twitter/tweet/advanced_search';

/** Skip RTs. All other filtering (replies vs threads) handled in Phase 2. */
function isNotRetweet(tweet: Tweet): boolean {
	return !tweet.retweeted_tweet && !tweet.text.startsWith('RT @');
}

/** Extract quoted tweet data for platform_metadata */
function extractQuotedTweet(tweet: Tweet): QuotedTweetData | undefined {
	const q = tweet.quoted_tweet;
	if (!q?.text || !q?.author) return undefined;
	return {
		authorName: q.author.name || '',
		authorUserName: q.author.userName || '',
		authorProfilePicture: q.author.profilePicture,
		text: q.text.replace(/https?:\/\/\S+/g, '').trim(),
	};
}

// -- Twitter Helpers ----------------------------------------------------------

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

function extractAuthor(tweet: Tweet) {
	return {
		authorName: tweet.author?.name || '',
		authorUserName: tweet.author?.userName || '',
		authorProfilePicture: tweet.author?.profilePicture,
	};
}

async function urlExists(db: Client, url: string): Promise<boolean> {
	const result = await db.query(`SELECT 1 FROM ${ARTICLES_TABLE} WHERE url = $1 LIMIT 1`, [url]);
	return result.rows.length > 0;
}

async function urlsExist(db: Client, urls: string[]): Promise<boolean> {
	const normalized = urls.map(normalizeUrl).filter(Boolean);
	if (normalized.length === 0) return false;
	const result = await db.query(`SELECT 1 FROM ${ARTICLES_TABLE} WHERE url = ANY($1) LIMIT 1`, [normalized]);
	return result.rows.length > 0;
}

/** Insert a twitter article and queue it for AI processing */
async function insertTwitterArticle(
	db: Client,
	env: Env,
	data: {
		url: string;
		title: string;
		source: string;
		publishedDate: Date;
		summary: string;
		content: string | null;
		ogImage: string | null;
		metadata: PlatformMetadata;
		hashTags?: string[];
	},
): Promise<string | null> {
	const articleId = await insertArticle(db, {
		url: data.url,
		title: data.title,
		source: data.source,
		publishedDate: data.publishedDate,
		summary: data.summary,
		sourceType: 'twitter',
		content: data.content,
		ogImageUrl: data.ogImage,
		platformMetadata: data.metadata,
		keywords: data.hashTags,
	});
	if (articleId) {
		await enqueueArticleProcess(env, articleId, 'twitter');
	}
	return articleId;
}

// -- Twitter Article (long-form) ----------------------------------------------

async function handleTwitterArticle(tweet: Tweet, db: Client, env: Env): Promise<boolean> {
	const expandedUrls = (tweet.urls || []).map((u) => u.expanded_url || u.url || '').filter(Boolean);
	const articleUrl = expandedUrls.find((u) => /(?:twitter\.com|x\.com)\/i\/article\//.test(u));
	if (!articleUrl) return false;

	const tweetId = tweet.id || tweet.url.split('/').pop();
	if (!tweetId) return false;

	logInfo('TWITTER', 'Detected Twitter Article', { tweetId, articleUrl });
	const scraped = await scrapeTwitterArticle(tweetId, env.KAITO_API_KEY || '');
	if (!scraped) {
		logWarn('TWITTER', 'Article API failed, falling through');
		return false;
	}

	const meta = scraped.metadata as Record<string, string | undefined> | undefined;
	const id = await insertTwitterArticle(db, env, {
		url: normalizeUrl(tweet.url),
		title: scraped.title,
		source: tweet.author?.name || 'Twitter',
		publishedDate: scraped.publishedDate ? new Date(scraped.publishedDate) : new Date(),
		summary: scraped.summary || '',
		content: scraped.content,
		ogImage: scraped.ogImageUrl || null,
		metadata: buildTwitterArticle({
			authorName: meta?.authorName || tweet.author?.name || '',
			authorUserName: meta?.authorUserName || tweet.author?.userName || '',
			authorProfilePicture: meta?.authorProfilePicture || tweet.author?.profilePicture,
		}),
	});

	if (id) logInfo('TWITTER', 'Saved Twitter Article', { title: scraped.title.slice(0, 50) });
	return !!id;
}

// -- Triage (rule-based, no AI) -----------------------------------------------

/** Rule-based content triage. Tracked users are curated, so no AI needed for quality gating. */
const MIN_TWEET_LENGTH = 150;

function triageTweet(textWithoutUrls: string, links: string[]): 'save' | 'follow_link' | 'discard' {
	if (textWithoutUrls.length < MIN_TWEET_LENGTH) return links.length > 0 ? 'follow_link' : 'discard';
	return 'save';
}

// -- Follow Link (tweet shares an external URL) -------------------------------

async function handleFollowLink(tweet: Tweet, textWithoutUrls: string, links: string[], db: Client, env: Env): Promise<boolean> {
	const resolvedUrl = await resolveUrl(links[0]!);

	if (isSocialMediaUrl(resolvedUrl)) {
		logInfo('TWITTER', 'Skipped social media link', { url: resolvedUrl });
		return false;
	}
	if (await urlsExist(db, [resolvedUrl])) {
		logInfo('TWITTER', 'Link already exists (dedup)', { url: resolvedUrl });
		return false;
	}

	const scraped = await scrapeWebPage(resolvedUrl).catch((err) => {
		logWarn('TWITTER', 'Failed to scrape followed link', { url: resolvedUrl, error: String(err) });
		return null;
	});
	if (!scraped) return false;

	// Skip if scraped content is too short to be meaningful
	if (!scraped.content || scraped.content.length < 100) {
		logInfo('TWITTER', 'Scraped content too short', { url: resolvedUrl, chars: scraped.content?.length ?? 0 });
		return false;
	}

	const id = await insertTwitterArticle(db, env, {
		url: resolvedUrl,
		title: scraped.title || 'Shared Article',
		source: tweet.author?.name || 'Twitter',
		publishedDate: tweet.createdAt ? new Date(tweet.createdAt) : new Date(),
		summary: '',
		content: scraped.content,
		ogImage: scraped.ogImageUrl,
		metadata: buildTwitterShared(extractAuthor(tweet), {
			media: extractTweetMedia(tweet),
			createdAt: tweet.createdAt,
			tweetText: textWithoutUrls,
			externalUrl: resolvedUrl,
			externalOgImage: scraped.ogImageUrl,
			externalTitle: scraped.title || null,
		}),
	});

	if (id) logInfo('TWITTER', 'Saved shared article', { title: scraped.title?.slice(0, 50) });
	return !!id;
}

// -- Save Single Tweet --------------------------------------------------------

async function saveTweet(tweet: Tweet, db: Client, env: Env): Promise<boolean> {
	const tweetUrl = normalizeUrl(tweet.url);
	if (await urlExists(db, tweetUrl)) return false;

	// 1. Twitter Article?
	if (await handleTwitterArticle(tweet, db, env)) return true;

	const links = tweet.text.match(/https?:\/\/\S+/g) || [];
	const textWithoutUrls = tweet.text.replace(/https?:\/\/\S+/g, '').trim();

	// 2. Rule-based triage (no AI — tracked users are curated)
	const triage = triageTweet(textWithoutUrls, links);

	if (triage === 'discard') {
		logInfo('TWITTER', 'Filtered tweet', { author: tweet.author?.userName, reason: 'too short, no links' });
		return false;
	}

	if (triage === 'follow_link') {
		return handleFollowLink(tweet, textWithoutUrls, links, db, env);
	}

	// 3. Save as tweet
	const expandedUrls = (tweet.urls || []).map((u) => u.expanded_url || u.url || '').filter(Boolean);
	const externalUrl = expandedUrls.find((u) => !/(?:twitter\.com|x\.com|t\.co)/.test(u));

	if (externalUrl && (await urlsExist(db, [externalUrl]))) {
		logInfo('TWITTER', 'External URL already exists (dedup)', { url: externalUrl });
		return false;
	}

	// Fetch external link metadata if present
	let externalOgImage: string | null = null;
	let externalTitle: string | null = null;
	let externalContent: string | null = null;
	if (externalUrl) {
		try {
			const scraped = await scrapeWebPage(externalUrl);
			externalOgImage = scraped.ogImageUrl;
			externalTitle = scraped.title || null;
			if (scraped.content && scraped.content.length > 100) externalContent = scraped.content;
		} catch (err) {
			logWarn('TWITTER', 'Failed to fetch external link metadata', { url: externalUrl, error: String(err) });
		}
	}

	const author = extractAuthor(tweet);
	const media = extractTweetMedia(tweet);
	const metadata = externalUrl
		? buildTwitterShared(author, {
				media,
				createdAt: tweet.createdAt,
				tweetText: textWithoutUrls,
				externalUrl,
				externalOgImage,
				externalTitle,
			})
		: buildTwitterStandard(author, { media, createdAt: tweet.createdAt, quotedTweet: extractQuotedTweet(tweet) });

	const id = await insertTwitterArticle(db, env, {
		url: tweetUrl,
		title: `@${tweet.author?.userName}: ${tweet.text.substring(0, 100)}${tweet.text.length > 100 ? '...' : ''}`,
		source: tweet.author?.name || 'Twitter',
		publishedDate: new Date(tweet.createdAt),
		summary: textWithoutUrls,
		content: externalContent || textWithoutUrls || null,
		ogImage: media[0]?.url ?? externalOgImage ?? null,
		metadata,
		hashTags: tweet.hashTags,
	});

	if (id) logInfo('TWITTER', 'Saved tweet', { author: tweet.author?.userName });
	return !!id;
}

// -- Save Thread (multiple tweets merged) -------------------------------------

async function saveThread(tweets: Tweet[], db: Client, env: Env): Promise<boolean> {
	const sorted = tweets.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
	const first = sorted[0];
	const firstUrl = normalizeUrl(first.url);

	// If root tweet already exists, update it with merged content
	const existing = await db.query(`SELECT id, content FROM ${ARTICLES_TABLE} WHERE url = $1 LIMIT 1`, [firstUrl]);

	// Dedup repeated text (e.g. same reply to multiple people) and cap at 10 tweets
	const seen = new Set<string>();
	const uniqueTexts: string[] = [];
	for (const t of sorted.slice(0, 10)) {
		const text = t.text.replace(/https?:\/\/\S+/g, '').trim();
		if (text && !seen.has(text)) {
			seen.add(text);
			uniqueTexts.push(text);
		}
	}
	const combinedText = uniqueTexts.join('\n\n');
	const allMedia = sorted.flatMap(extractTweetMedia);
	const quotedTweet = sorted.map(extractQuotedTweet).find(Boolean);
	const author = extractAuthor(first);
	const metadata = buildTwitterStandard(author, { media: allMedia, createdAt: first.createdAt, quotedTweet });

	if (existing.rows.length > 0) {
		// Update existing root tweet with merged thread content and re-queue for AI processing
		const existingId = existing.rows[0].id;
		await db.query(
			`UPDATE ${ARTICLES_TABLE} SET summary = $1, content = $2, platform_metadata = $3, summary_cn = NULL, content_cn = NULL, title_cn = NULL, embedding = NULL WHERE id = $4`,
			[combinedText, combinedText, JSON.stringify(metadata), existingId],
		);
		await enqueueArticleProcess(env, existingId, 'twitter');
		logInfo('TWITTER', 'Updated thread', { author: first.author?.userName, tweets: sorted.length });
		return true;
	}

	const id = await insertTwitterArticle(db, env, {
		url: firstUrl,
		title: `@${first.author?.userName}: ${first.text.substring(0, 100)}${first.text.length > 100 ? '...' : ''}`,
		source: first.author?.name || 'Twitter',
		publishedDate: new Date(first.createdAt),
		summary: combinedText,
		content: combinedText,
		ogImage: allMedia[0]?.url ?? null,
		metadata,
		hashTags: first.hashTags,
	});

	if (id) logInfo('TWITTER', 'Saved thread', { author: first.author?.userName, tweets: sorted.length });
	return !!id;
}

/** Max usernames per query batch to stay within query length limits */
const TWITTER_BATCH_SIZE = 20;

/** Format a unix timestamp (seconds) to Twitter advanced search date format */
function toTwitterDate(epochSec: number): string {
	return new Date(epochSec * 1000)
		.toISOString()
		.replace('T', '_')
		.replace(/\.\d+Z$/, '_UTC');
}

// -- Twitter Cron: staged pipeline --------------------------------------------

async function getTwitterUsersToMonitor(db: Client): Promise<RSSFeed[]> {
	const result = await db.query(`SELECT id, name, "RSSLink", url, type, scraped_at FROM "RssList" WHERE type = $1`, ['twitter_user']);
	return result.rows as RSSFeed[];
}

/**
 * Global sinceTime = oldest scraped_at across all users minus a 1h overlap.
 * If no user has been scraped before, fall back to 24h ago.
 */
function calculateMonitoringSinceTime(users: RSSFeed[]): number {
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

/** Fetch all tweets matching `(from:u1 OR from:u2 …) since:<date>`, paginating through cursors. */
async function fetchTweetsForBatch(
	apiKey: string,
	userNames: string[],
	sinceTime: number,
): Promise<{ tweets: Tweet[]; completed: boolean }> {
	const fromClause = userNames.map((u) => `from:${u}`).join(' OR ');
	const sinceDate = toTwitterDate(sinceTime);
	const query = `(${fromClause}) since:${sinceDate}`;

	const tweets: Tweet[] = [];
	let cursor = '';

	while (true) {
		const params = new URLSearchParams({ query, queryType: 'Latest' });
		if (cursor) params.set('cursor', cursor);

		const res = await fetchWithTimeout(
			`${TWITTER_ADVANCED_SEARCH_API}?${params}`,
			{ headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' } },
			20_000,
		);
		if (!res.ok) {
			logError('TWITTER', 'Advanced Search HTTP error', { status: res.status, statusText: res.statusText });
			return { tweets, completed: false };
		}

		const apiRes = (await res.json()) as { tweets?: Tweet[]; has_next_page?: boolean; next_cursor?: string };
		for (const tweet of apiRes.tweets || []) {
			if (isNotRetweet(tweet)) tweets.push(tweet);
		}

		if (!apiRes.has_next_page) break;
		cursor = apiRes.next_cursor || '';
		if (!cursor) break;
		await new Promise((r) => setTimeout(r, 1000));
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
	for (const tweet of [...rootTweets, ...threadReplies, ...orphanReplies]) {
		const key = tweet.conversationId || tweet.id || tweet.url;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key)!.push(tweet);
	}
	return [...groups.values()];
}

async function saveTweetGroups(db: Client, env: Env, groups: Tweet[][]): Promise<number> {
	let count = 0;
	for (const group of groups) {
		try {
			if (group.length >= 2) {
				if (await saveThread(group, db, env)) count++;
			} else {
				if (await saveTweet(group[0], db, env)) count++;
			}
		} catch (err) {
			logError('TWITTER', 'Save failed', { url: group[0]?.url, error: String(err) });
		}
	}
	return count;
}

export async function handleTwitterCron(env: Env, _ctx: ExecutionContext): Promise<void> {
	logInfo('TWITTER', 'start');
	const db = await createDbClient(env);
	try {
		const users = await getTwitterUsersToMonitor(db);
		if (!users.length) {
			logInfo('TWITTER', 'No twitter_user entries in RssList');
			return;
		}

		const sinceTime = calculateMonitoringSinceTime(users);
		const userNames = users.map((u) => u.RSSLink).filter(Boolean);
		const batches: string[][] = [];
		for (let i = 0; i < userNames.length; i += TWITTER_BATCH_SIZE) {
			batches.push(userNames.slice(i, i + TWITTER_BATCH_SIZE));
		}

		logInfo('TWITTER', 'Fetching via Advanced Search', { users: userNames.length, batches: batches.length, sinceTime });

		let total = 0;
		let allCompleted = true;
		for (const batch of batches) {
			const { tweets, completed } = await fetchTweetsForBatch(env.KAITO_API_KEY || '', batch, sinceTime);
			if (!completed) allCompleted = false;
			const groups = groupTweetsIntoThreads(tweets);
			total += await saveTweetGroups(db, env, groups);
		}

		// Advance scraped_at only if every batch completed — partial fetches would
		// let the next cron skip tweets we failed to pull.
		if (allCompleted) {
			await db.query(`UPDATE "RssList" SET scraped_at = $1 WHERE id = ANY($2)`, [new Date(), users.map((u) => u.id)]);
		}

		logInfo('TWITTER', 'end', { inserted: total, users: users.length, batches: batches.length });
	} finally {
		await db.end();
	}
}
