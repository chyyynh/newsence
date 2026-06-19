import { ARTICLES_TABLE, createDbClient, enqueueArticleProcess, insertArticle } from '@shared/db';
import type { PlatformMetadata, RetweetedByData, TwitterMedia } from '@shared/platform-metadata';
import type { Env, ExecutionContext, RSSFeed, Tweet } from '@shared/types';
import { fetchJsonWithTimeout, isSocialMediaUrl, normalizeUrl, resolveUrl, type ScrapedContent } from '@shared/web';
import type { Client } from 'pg';
import { scrapeWebPage } from '../web/scraper';
import {
	buildTweetPlatformMetadata,
	buildTweetTitle,
	buildTwitterArticlePlatformMetadata,
	extractExpandedUrls,
	extractQuotedTweet,
	extractTweetMedia,
	findExternalUrl,
	findTwitterArticleUrl,
	scrapeTwitterArticle,
	stripTweetUrls,
} from './scraper';

// ─────────────────────────────────────────────────────────────
// Twitter Monitor
// ─────────────────────────────────────────────────────────────

const TWITTER_ADVANCED_SEARCH_API = 'https://api.twitterapi.io/twitter/tweet/advanced_search';

type TwitterSourceEventType = 'tweet' | 'thread' | 'share' | 'quote' | 'retweet' | 'article';

function buildRetweetedBy(tweet: Tweet): RetweetedByData {
	return {
		tweetId: tweet.id,
		tweetUrl: tweet.url,
		retweetedAt: tweet.createdAt,
		authorName: tweet.author?.name || '',
		authorUserName: tweet.author?.userName || '',
		authorProfilePicture: tweet.author?.profilePicture,
		authorVerified: tweet.author?.isBlueVerified,
	};
}

function normalizeRetweet(tweet: Tweet): Tweet | null {
	if (tweet.retweeted_tweet) {
		return { ...tweet.retweeted_tweet, retweetedBy: buildRetweetedBy(tweet) };
	}
	if (tweet.text.startsWith('RT @')) return null;
	return tweet;
}

function sourceEventTypeFor(tweet: Tweet, eventType: TwitterSourceEventType): TwitterSourceEventType {
	if (tweet.retweetedBy) return 'retweet';
	if (eventType === 'tweet' && tweet.quoted_tweet) return 'quote';
	return eventType;
}

function publicMetricsFor(tweet: Tweet): Record<string, number | undefined> {
	return {
		viewCount: tweet.viewCount,
		likeCount: tweet.likeCount,
		retweetCount: tweet.retweetCount,
		replyCount: tweet.replyCount,
		quoteCount: tweet.quoteCount,
	};
}

async function findArticleByUrl(db: Client, url: string): Promise<{ id: string; summary_cn: string | null } | null> {
	const result = await db.query<{ id: string; summary_cn: string | null }>(
		`SELECT id, summary_cn FROM ${ARTICLES_TABLE} WHERE url = $1 LIMIT 1`,
		[url],
	);
	return result.rows[0] ?? null;
}

async function enqueueMissingTwitterTranslation(env: Env, article: { id: string; summary_cn: string | null }): Promise<void> {
	if (article.summary_cn) return;
	await enqueueArticleProcess(env, article.id);
}

async function upsertTwitterSourceEvent(
	db: Client,
	tweet: Tweet,
	options: {
		articleId: string | null;
		eventType: TwitterSourceEventType;
		text?: string | null;
		media?: TwitterMedia[];
		raw?: unknown;
	},
): Promise<void> {
	const eventTweetId = tweet.retweetedBy?.tweetId ?? tweet.id;
	const eventTweetUrl = tweet.retweetedBy?.tweetUrl ?? tweet.url;
	if (!eventTweetId || !eventTweetUrl) return;

	const author = tweet.retweetedBy
		? {
				name: tweet.retweetedBy.authorName,
				userName: tweet.retweetedBy.authorUserName,
				profilePicture: tweet.retweetedBy.authorProfilePicture,
				isBlueVerified: tweet.retweetedBy.authorVerified,
			}
		: tweet.author;
	const createdAt = tweet.retweetedBy?.retweetedAt ?? tweet.createdAt;
	const eventType = sourceEventTypeFor(tweet, options.eventType);
	const text = options.text ?? stripTweetUrls(tweet.text);
	const mediaAssets = options.media ?? extractTweetMedia(tweet);
	const raw = options.raw ?? tweet;

	try {
		const event = await db.query<{ id: string }>(
			`INSERT INTO twitter_source_events (
				tweet_id, tweet_url, event_type, article_id,
				author_user_name, author_name, author_profile_picture, author_verified,
				text, created_at, lang, public_metrics, raw
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb)
			ON CONFLICT (tweet_id) DO UPDATE SET
				tweet_url = EXCLUDED.tweet_url,
				event_type = EXCLUDED.event_type,
				article_id = COALESCE(EXCLUDED.article_id, twitter_source_events.article_id),
				author_user_name = EXCLUDED.author_user_name,
				author_name = EXCLUDED.author_name,
				author_profile_picture = EXCLUDED.author_profile_picture,
				author_verified = EXCLUDED.author_verified,
				text = EXCLUDED.text,
				created_at = EXCLUDED.created_at,
				lang = EXCLUDED.lang,
				public_metrics = EXCLUDED.public_metrics,
				raw = EXCLUDED.raw
			RETURNING id`,
			[
				eventTweetId,
				eventTweetUrl,
				eventType,
				options.articleId,
				author?.userName || '',
				author?.name || '',
				author?.profilePicture,
				author?.isBlueVerified,
				text,
				createdAt,
				tweet.lang,
				JSON.stringify(publicMetricsFor(tweet)),
				JSON.stringify(raw),
			],
		);
		const sourceEventId = event.rows[0]?.id;
		if (!sourceEventId) return;

		await db.query('DELETE FROM twitter_media_assets WHERE source_event_id = $1', [sourceEventId]);
		for (const media of mediaAssets) {
			await db.query(
				`INSERT INTO twitter_media_assets (
					source_event_id, media_type, url, video_url, width, height
				) VALUES ($1, $2, $3, $4, $5, $6)`,
				[sourceEventId, media.type, media.url, media.videoUrl, media.width, media.height],
			);
		}

		const references: Array<{ id: string; type: 'quoted' | 'retweeted' | 'replied_to'; metadata?: Record<string, unknown> }> = [];
		if (tweet.retweetedBy && tweet.id) references.push({ id: tweet.id, type: 'retweeted' });
		if (tweet.quoted_tweet?.id) {
			references.push({
				id: tweet.quoted_tweet.id,
				type: 'quoted',
				metadata: {
					authorUserName: tweet.quoted_tweet.author?.userName,
					authorName: tweet.quoted_tweet.author?.name,
					text: stripTweetUrls(tweet.quoted_tweet.text),
				},
			});
		}
		if (tweet.inReplyToId) references.push({ id: tweet.inReplyToId, type: 'replied_to' });

		await db.query('DELETE FROM twitter_references WHERE source_event_id = $1', [sourceEventId]);
		for (const reference of references) {
			await db.query(
				`INSERT INTO twitter_references (
					source_event_id, referenced_tweet_id, reference_type, metadata
				) VALUES ($1, $2, $3, $4::jsonb)
				ON CONFLICT (source_event_id, referenced_tweet_id, reference_type)
				DO UPDATE SET metadata = EXCLUDED.metadata`,
				[sourceEventId, reference.id, reference.type, JSON.stringify(reference.metadata ?? null)],
			);
		}
	} catch (err) {
		console.warn({ tag: 'TWITTER', msg: 'Source event write skipped', tweetId: eventTweetId, error: String(err) });
	}
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
		await enqueueArticleProcess(env, articleId);
	}
	return articleId;
}

// -- Twitter Article (long-form) ----------------------------------------------

async function handleTwitterArticle(tweet: Tweet, db: Client, env: Env, expandedUrls: string[]): Promise<boolean> {
	const articleUrl = findTwitterArticleUrl(expandedUrls);
	if (!articleUrl) return false;

	const tweetId = tweet.id || tweet.url.split('/').pop();
	if (!tweetId) return false;

	console.info({ tag: 'TWITTER', msg: 'Detected Twitter Article', tweetId, articleUrl });
	const scraped = await scrapeTwitterArticle(tweetId, env.KAITO_API_KEY || '');
	if (!scraped) {
		console.warn({ tag: 'TWITTER', msg: 'Article API failed, falling through' });
		return false;
	}

	const meta = scraped.metadata;
	const authorVerified = typeof meta?.authorVerified === 'boolean' ? meta.authorVerified : tweet.author?.isBlueVerified;
	const id = await insertTwitterArticle(db, env, {
		url: normalizeUrl(tweet.url),
		title: scraped.title,
		source: tweet.author?.name || 'Twitter',
		publishedDate: scraped.publishedDate ? new Date(scraped.publishedDate) : new Date(),
		summary: scraped.summary || '',
		content: scraped.content,
		ogImage: scraped.ogImageUrl || null,
		metadata: buildTwitterArticlePlatformMetadata(tweetId, {
			name: typeof meta?.authorName === 'string' ? meta.authorName : tweet.author?.name,
			userName: typeof meta?.authorUserName === 'string' ? meta.authorUserName : tweet.author?.userName,
			profilePicture: typeof meta?.authorProfilePicture === 'string' ? meta.authorProfilePicture : tweet.author?.profilePicture,
			isBlueVerified: authorVerified,
		}),
	});

	if (id) {
		await upsertTwitterSourceEvent(db, tweet, { articleId: id, eventType: 'article', text: scraped.summary || stripTweetUrls(tweet.text) });
		console.info({ tag: 'TWITTER', msg: 'Saved Twitter Article', title: scraped.title.slice(0, 50) });
	}
	return !!id;
}

// -- Triage (rule-based, no AI) -----------------------------------------------

/** Rule-based content triage. Tracked users are curated, so no AI needed for quality gating. */
const MIN_TWEET_LENGTH = 150;

function shouldSaveStandaloneTweet(textWithoutUrls: string): boolean {
	return textWithoutUrls.length >= MIN_TWEET_LENGTH;
}

// -- Follow Link (tweet shares an external URL) -------------------------------

type FollowLinkResult =
	| { status: 'inserted' }
	| { status: 'handled' }
	| { status: 'skipped'; resolvedUrl?: string; scraped?: ScrapedContent | null };

async function handleFollowLink(
	tweet: Tweet,
	textWithoutUrls: string,
	externalUrl: string,
	db: Client,
	env: Env,
): Promise<FollowLinkResult> {
	const resolvedUrl = await resolveUrl(externalUrl).catch((err) => {
		console.warn({ tag: 'TWITTER', msg: 'Failed to resolve shared link', url: externalUrl, error: String(err) });
		return null;
	});
	if (!resolvedUrl) return { status: 'skipped' };

	if (isSocialMediaUrl(resolvedUrl)) {
		console.info({ tag: 'TWITTER', msg: 'Skipped social media link', url: resolvedUrl });
		return { status: 'skipped', resolvedUrl };
	}
	const existingArticle = await findArticleByUrl(db, resolvedUrl);
	if (existingArticle) {
		await upsertTwitterSourceEvent(db, tweet, { articleId: existingArticle.id, eventType: 'share', text: textWithoutUrls });
		await enqueueMissingTwitterTranslation(env, existingArticle);
		console.info({ tag: 'TWITTER', msg: 'Link already exists (dedup)', url: resolvedUrl });
		return { status: 'handled' };
	}

	const scraped = await scrapeWebPage(resolvedUrl).catch((err) => {
		console.warn({ tag: 'TWITTER', msg: 'Failed to scrape followed link', url: resolvedUrl, error: String(err) });
		return null;
	});
	if (!scraped) return { status: 'skipped', resolvedUrl };

	// Skip if scraped content is too short to be meaningful
	if (!scraped.content || scraped.content.length < 100) {
		console.info({ tag: 'TWITTER', msg: 'Scraped content too short', url: resolvedUrl, chars: scraped.content?.length ?? 0 });
		return { status: 'skipped', resolvedUrl, scraped };
	}

	const id = await insertTwitterArticle(db, env, {
		url: resolvedUrl,
		title: scraped.title || 'Shared Article',
		source: tweet.author?.name || 'Twitter',
		publishedDate: tweet.createdAt ? new Date(tweet.createdAt) : new Date(),
		summary: '',
		content: scraped.content,
		ogImage: scraped.ogImageUrl,
		metadata: buildTweetPlatformMetadata(tweet, {
			tweetText: textWithoutUrls,
			externalUrl: resolvedUrl,
			externalOgImage: scraped.ogImageUrl,
			externalTitle: scraped.title || null,
			originalTweetUrl: tweet.url,
		}),
	});

	if (id) {
		await upsertTwitterSourceEvent(db, tweet, { articleId: id, eventType: 'share', text: textWithoutUrls });
		console.info({ tag: 'TWITTER', msg: 'Saved shared article', title: scraped.title?.slice(0, 50) });
	}
	return id ? { status: 'inserted' } : { status: 'skipped', resolvedUrl, scraped };
}

// -- Save Single Tweet --------------------------------------------------------

async function saveTweet(tweet: Tweet, db: Client, env: Env): Promise<boolean> {
	const tweetUrl = normalizeUrl(tweet.url);
	const expandedUrls = extractExpandedUrls(tweet);
	const externalUrl = findExternalUrl(expandedUrls);
	const textWithoutUrls = stripTweetUrls(tweet.text);

	const existingTweetArticle = await findArticleByUrl(db, tweetUrl);
	if (existingTweetArticle) {
		await upsertTwitterSourceEvent(db, tweet, {
			articleId: existingTweetArticle.id,
			eventType: externalUrl ? 'share' : 'tweet',
			text: textWithoutUrls,
		});
		await enqueueMissingTwitterTranslation(env, existingTweetArticle);
		return false;
	}

	// 1. Twitter Article?
	if (await handleTwitterArticle(tweet, db, env, expandedUrls)) return true;

	// 2. External link? Prefer one canonical article row for the linked page,
	// with this tweet captured as a source event. Fall back to standalone tweet
	// only when the linked page cannot be scraped into meaningful content.
	let linkFallback: Extract<FollowLinkResult, { status: 'skipped' }> | null = null;
	if (externalUrl) {
		const linkResult = await handleFollowLink(tweet, textWithoutUrls, externalUrl, db, env);
		if (linkResult.status === 'inserted') return true;
		if (linkResult.status === 'handled') return false;
		linkFallback = linkResult;
	}

	// 3. Rule-based triage (no AI — tracked users are curated). Retweets are
	// kept even when short: the tracked user's retweet is itself a curator
	// signal, and the saved article is what gets translated for the feed.
	if (!tweet.retweetedBy && !shouldSaveStandaloneTweet(textWithoutUrls)) {
		console.info({ tag: 'TWITTER', msg: 'Filtered tweet', author: tweet.author?.userName, reason: 'too short standalone tweet' });
		return false;
	}

	// 4. Save as tweet
	const metadataExternalUrl = linkFallback?.resolvedUrl ?? externalUrl;
	const externalOgImage = linkFallback?.scraped?.ogImageUrl ?? null;
	const externalTitle = linkFallback?.scraped?.title || null;

	const metadata = buildTweetPlatformMetadata(
		tweet,
		metadataExternalUrl
			? { tweetText: textWithoutUrls, externalUrl: metadataExternalUrl, externalOgImage, externalTitle, originalTweetUrl: tweet.url }
			: {},
	);
	const media = metadata.data.media ?? [];

	const id = await insertTwitterArticle(db, env, {
		url: tweetUrl,
		title: buildTweetTitle(tweet),
		source: tweet.author?.name || 'Twitter',
		publishedDate: new Date(tweet.createdAt),
		summary: textWithoutUrls,
		content: textWithoutUrls || null,
		ogImage: media[0]?.url ?? externalOgImage ?? null,
		metadata,
		hashTags: tweet.hashTags,
	});

	if (id) {
		await upsertTwitterSourceEvent(db, tweet, { articleId: id, eventType: externalUrl ? 'share' : 'tweet', text: textWithoutUrls });
		console.info({ tag: 'TWITTER', msg: 'Saved tweet', author: tweet.author?.userName });
	}
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
		const text = stripTweetUrls(t.text);
		if (text && !seen.has(text)) {
			seen.add(text);
			uniqueTexts.push(text);
		}
	}
	const combinedText = uniqueTexts.join('\n\n');
	const allMedia = sorted.flatMap(extractTweetMedia);
	const quotedTweet = sorted.map(extractQuotedTweet).find(Boolean);
	const metadata = buildTweetPlatformMetadata(first, { media: allMedia, quotedTweet });

	if (existing.rows.length > 0) {
		// Update existing root tweet with merged thread content and re-queue for AI processing
		const existingId = existing.rows[0].id;
		await db.query(
			`UPDATE ${ARTICLES_TABLE} SET summary = $1, content = $2, platform_metadata = $3, summary_cn = NULL, content_cn = NULL, title_cn = NULL, embedding = NULL WHERE id = $4`,
			[combinedText, combinedText, JSON.stringify(metadata), existingId],
		);
		await enqueueArticleProcess(env, existingId);
		await upsertTwitterSourceEvent(db, first, {
			articleId: existingId,
			eventType: 'thread',
			text: combinedText,
			media: allMedia,
			raw: { tweets: sorted },
		});
		console.info({ tag: 'TWITTER', msg: 'Updated thread', author: first.author?.userName, tweets: sorted.length });
		return true;
	}

	const id = await insertTwitterArticle(db, env, {
		url: firstUrl,
		title: buildTweetTitle(first),
		source: first.author?.name || 'Twitter',
		publishedDate: new Date(first.createdAt),
		summary: combinedText,
		content: combinedText,
		ogImage: allMedia[0]?.url ?? null,
		metadata,
		hashTags: first.hashTags,
	});

	if (id) {
		await upsertTwitterSourceEvent(db, first, {
			articleId: id,
			eventType: 'thread',
			text: combinedText,
			media: allMedia,
			raw: { tweets: sorted },
		});
		console.info({ tag: 'TWITTER', msg: 'Saved thread', author: first.author?.userName, tweets: sorted.length });
	}
	return !!id;
}

/** Max usernames per query batch to stay within query length limits */
const TWITTER_BATCH_SIZE = 20;
const TWITTER_USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;
const TWITTER_NON_PROFILE_PATHS = new Set(['home', 'i', 'intent', 'search', 'share']);

type MonitoredTwitterUser = RSSFeed & { twitterUserName: string };

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

// -- Twitter Cron: staged pipeline --------------------------------------------

async function getTwitterUsersToMonitor(db: Client): Promise<RSSFeed[]> {
	const result = await db.query(`SELECT id, name, "RSSLink", url, type, scraped_at FROM "RssList" WHERE type = $1`, ['twitter_user']);
	return result.rows as RSSFeed[];
}

function normalizeTwitterUsers(users: RSSFeed[]): MonitoredTwitterUser[] {
	return users.flatMap((user) => {
		const twitterUserName = normalizeTwitterUserName(user.RSSLink);
		return twitterUserName ? [{ ...user, twitterUserName }] : [];
	});
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

	while (true) {
		const params = new URLSearchParams({ query, queryType: 'Latest' });
		if (cursor) params.set('cursor', cursor);

		let apiRes: { tweets?: Tweet[]; has_next_page?: boolean; next_cursor?: string };
		try {
			apiRes = await fetchJsonWithTimeout(
				`${TWITTER_ADVANCED_SEARCH_API}?${params}`,
				{ headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' } },
				20_000,
				2 * 1024 * 1024,
			);
		} catch (err) {
			console.error({ tag: 'TWITTER', msg: 'Advanced Search fetch failed', error: String(err) });
			return { tweets, completed: false };
		}
		for (const tweet of apiRes.tweets || []) {
			const normalized = normalizeRetweet(tweet);
			if (normalized) tweets.push(normalized);
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
			console.error({ tag: 'TWITTER', msg: 'Save failed', url: group[0]?.url, error: String(err) });
		}
	}
	return count;
}

export async function handleTwitterCron(env: Env, _ctx: ExecutionContext): Promise<void> {
	console.info({ tag: 'TWITTER', msg: 'start' });
	const db = await createDbClient(env);
	try {
		const users = await getTwitterUsersToMonitor(db);
		if (!users.length) {
			console.info({ tag: 'TWITTER', msg: 'No twitter_user entries in RssList' });
			return;
		}

		const monitoredUsers = normalizeTwitterUsers(users);
		const userNames = [...new Set(monitoredUsers.map((u) => u.twitterUserName))];
		if (userNames.length === 0) {
			console.warn({ tag: 'TWITTER', msg: 'No valid twitter usernames in RssList', users: users.length });
			return;
		}
		const sinceTime = calculateMonitoringSinceTime(monitoredUsers);
		const batches: string[][] = [];
		for (let i = 0; i < userNames.length; i += TWITTER_BATCH_SIZE) {
			batches.push(userNames.slice(i, i + TWITTER_BATCH_SIZE));
		}

		console.info({ tag: 'TWITTER', msg: 'Fetching via Advanced Search', users: userNames.length, batches: batches.length, sinceTime });

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
			await db.query(`UPDATE "RssList" SET scraped_at = $1 WHERE id = ANY($2)`, [new Date(), monitoredUsers.map((u) => u.id)]);
		}

		console.info({
			tag: 'TWITTER',
			msg: 'end',
			inserted: total,
			users: users.length,
			validUsers: monitoredUsers.length,
			batches: batches.length,
		});
	} finally {
		await db.end();
	}
}
