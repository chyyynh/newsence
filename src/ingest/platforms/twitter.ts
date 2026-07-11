import type { PlatformMetadata, ResourceForProcessing } from '@core-shared/types';
import { fetchWithTimeout, normalizeUrl, readTextWithLimit } from '@core-shared/web';
import { withCoreDb } from '@db/client';
import { getExistingResourcesByUrl, reopenResourceForReprocessing, upsertPendingSourceResource } from '@ingest/domain/resource-store';
import { loadEnabledSources, type MonitoredSource, markSourcesScraped } from '@ingest/domain/source-store';
import { enqueueProcessing } from '@ingest/workflow';
import { generateResourceClassification, isEmpty, mergeResourceClassification, type ProcessorResult } from '../domain/ai-utils';
import { buildThreadResourceParts, buildTweetTitle, resolveTweetContent, type Tweet } from './twitter-acquisition';

async function enqueueTwitterResource(
	env: CoreEnv,
	data: {
		url: string;
		title: string;
		source: string;
		publishedDate: Date;
		summary: string;
		originalLang?: string;
		content: string | null;
		platformMetadata: PlatformMetadata;
		hashTags?: string[];
	},
): Promise<void> {
	const resourceId = await withCoreDb(env, (db) =>
		upsertPendingSourceResource(db, {
			url: data.url,
			title: data.title,
			source: data.source,
			publishedDate: data.publishedDate,
			summary: data.summary,
			type: 'twitter',
			originalLang: data.originalLang,
			content: data.content,
			platformMetadata: data.platformMetadata,
			keywords: data.hashTags,
		}),
	);
	await enqueueProcessing(env, resourceId);
}

const MIN_TWEET_LENGTH = 150;

async function reuseExistingTweet(env: CoreEnv, url: string): Promise<boolean> {
	const [existing] = await withCoreDb(env, (db) => getExistingResourcesByUrl(db, [url]));
	if (!existing) return false;
	if (existing.shouldRetryEnrichment) await enqueueProcessing(env, existing.id);
	console.info({ tag: 'TWITTER', msg: 'Resource already exists (dedup)', url });
	return true;
}

async function saveTweet(tweet: Tweet, env: CoreEnv): Promise<boolean> {
	let knownUrl: string | null = null;
	try {
		knownUrl = tweet.url ? normalizeUrl(tweet.url) : null;
	} catch {
		// Let content resolution surface a useful error for malformed API data.
	}
	if (knownUrl && (await reuseExistingTweet(env, knownUrl))) return true;

	const resolved = await resolveTweetContent(tweet, env.KAITO_API_KEY);

	if (resolved.kind === 'tweet' && !tweet.retweetedBy && resolved.eventText.length < MIN_TWEET_LENGTH) {
		console.info({ tag: 'TWITTER', msg: 'Filtered tweet', author: tweet.author?.userName, reason: 'too short standalone tweet' });
		return false;
	}

	const resourceUrl = normalizeUrl(resolved.canonicalUrl);
	if (resourceUrl !== knownUrl && (await reuseExistingTweet(env, resourceUrl))) return true;

	const { scraped } = resolved;
	const title = scraped.title || buildTweetTitle(tweet);
	const source =
		resolved.kind === 'share'
			? scraped.metadata.siteName || scraped.metadata.author || 'External'
			: tweet.author?.name || scraped.metadata.author || 'Twitter';
	await enqueueTwitterResource(env, {
		url: resourceUrl,
		title,
		source,
		publishedDate: new Date(scraped.metadata.publishedDate || tweet.createdAt),
		summary: resolved.kind === 'tweet' ? resolved.eventText : scraped.metadata.description || '',
		originalLang: scraped.metadata.language ?? undefined,
		content: resolved.kind === 'tweet' ? resolved.eventText || null : scraped.markdown,
		platformMetadata: scraped.platformMetadata,
		hashTags: tweet.hashTags,
	});
	console.info({ tag: 'TWITTER', msg: 'Saved tweet content', kind: resolved.kind, title: title.slice(0, 50) });
	return true;
}

async function saveThread(tweets: Tweet[], env: CoreEnv): Promise<boolean> {
	const { first, combinedText, platformMetadata } = buildThreadResourceParts(tweets);
	const firstUrl = normalizeUrl(first.url);
	const tweetCount = tweets.length;

	const [existing] = await withCoreDb(env, (db) => getExistingResourcesByUrl(db, [firstUrl]));

	if (existing) {
		const existingId = existing.id;
		const changed = await reopenResourceForReprocessing(env, existingId, {
			summary: combinedText,
			content: combinedText,
			platformMetadata,
		});
		if (changed || existing.shouldRetryEnrichment) await enqueueProcessing(env, existingId);
		console.info({
			tag: 'TWITTER',
			msg: changed ? 'Updated thread' : 'Thread unchanged',
			author: first.author?.userName,
			tweets: tweetCount,
		});
		return true;
	}

	await enqueueTwitterResource(env, {
		url: firstUrl,
		title: buildTweetTitle(first),
		source: first.author?.name || 'Twitter',
		publishedDate: new Date(first.createdAt),
		summary: combinedText,
		originalLang: first.lang,
		content: combinedText,
		platformMetadata,
		hashTags: first.hashTags,
	});
	console.info({ tag: 'TWITTER', msg: 'Saved thread', author: first.author?.userName, tweets: tweetCount });
	return true;
}

// Twitter Monitor

const TWITTER_ADVANCED_SEARCH_API = 'https://api.twitterapi.io/twitter/tweet/advanced_search';

/** Max usernames per query batch to stay within query length limits */
const TWITTER_BATCH_SIZE = 20;
const TWITTER_USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;
const TWITTER_NON_PROFILE_PATHS = new Set(['home', 'i', 'intent', 'search', 'share']);
const TWITTER_INITIAL_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const TWITTER_WATERMARK_OVERLAP_MS = 60 * 60 * 1000;

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

/** Oldest effective watermark in one API batch, minus a one-hour overlap. */
function calculateMonitoringSinceTime(users: Array<{ scrapedAt?: Date | string | null }>): number {
	const fallback = Date.now() - TWITTER_INITIAL_LOOKBACK_MS;
	let oldest = Number.POSITIVE_INFINITY;
	for (const user of users) {
		const timestamp = user.scrapedAt ? new Date(user.scrapedAt).getTime() : Number.NaN;
		oldest = Math.min(oldest, Number.isFinite(timestamp) ? timestamp : fallback);
	}
	return Math.floor(((Number.isFinite(oldest) ? oldest : fallback) - TWITTER_WATERMARK_OVERLAP_MS) / 1000);
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
	const seenCursors = new Set<string>();

	while (true) {
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
		cursor = apiRes.next_cursor || '';
		if (!cursor) break;
		if (seenCursors.has(cursor)) {
			console.error({ tag: 'TWITTER', msg: 'Advanced Search returned a repeated cursor', cursor: cursor.slice(0, 32) });
			return { tweets, completed: false };
		}
		seenCursors.add(cursor);
		await scheduler.wait(1000);
	}

	return { tweets, completed: true };
}

/**
 * Group tweets by conversation so threads can be saved as a single merged resource.
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

type MonitoredTwitterUser = MonitoredSource & { twitterUserName: string };

type MonitoredTwitterIdentity = {
	twitterUserName: string;
	sources: MonitoredTwitterUser[];
};

function monitoredTwitterUsers(users: MonitoredSource[]): MonitoredTwitterUser[] {
	return users.flatMap((user) => {
		const twitterUserName = normalizeTwitterUserName(user.handle);
		return twitterUserName ? [{ ...user, twitterUserName: twitterUserName.toLowerCase() }] : [];
	});
}

function monitoredTwitterIdentities(users: MonitoredTwitterUser[]): MonitoredTwitterIdentity[] {
	const byUserName = new Map<string, MonitoredTwitterUser[]>();
	for (const user of users) {
		const sources = byUserName.get(user.twitterUserName) ?? [];
		sources.push(user);
		byUserName.set(user.twitterUserName, sources);
	}
	return [...byUserName].map(([twitterUserName, sources]) => ({ twitterUserName, sources }));
}

function batchTwitterIdentities(identities: MonitoredTwitterIdentity[]): MonitoredTwitterIdentity[][] {
	const batches: MonitoredTwitterIdentity[][] = [];
	for (let i = 0; i < identities.length; i += TWITTER_BATCH_SIZE) {
		batches.push(identities.slice(i, i + TWITTER_BATCH_SIZE));
	}
	return batches;
}

function monitoredAuthorUserName(tweet: Tweet): string | null {
	const userName = tweet.retweetedBy?.authorUserName || tweet.author?.userName;
	return userName?.trim().toLowerCase() || null;
}

type TweetSaveResult = {
	processed: number;
	failedUserNames: Set<string>;
	hasUnattributedFailure: boolean;
};

async function saveTweetGroups(env: CoreEnv, tweets: Tweet[]): Promise<TweetSaveResult> {
	let processed = 0;
	const failedUserNames = new Set<string>();
	let hasUnattributedFailure = false;
	for (const group of groupTweetsIntoThreads(tweets)) {
		const first = group[0];
		if (!first) continue;
		try {
			const saved = group.length >= 2 ? await saveThread(group, env) : await saveTweet(first, env);
			if (saved) processed++;
		} catch (err) {
			const userName = monitoredAuthorUserName(first);
			if (userName) failedUserNames.add(userName);
			else hasUnattributedFailure = true;
			console.error({ tag: 'TWITTER', msg: 'Save failed', url: first.url, error: String(err) });
		}
	}
	return { processed, failedUserNames, hasUnattributedFailure };
}

async function processTwitterBatches(
	env: CoreEnv,
	batches: MonitoredTwitterIdentity[][],
	runStartedAt: Date,
): Promise<{ processed: number; advancedSources: number; incompleteBatches: number }> {
	let processed = 0;
	let advancedSources = 0;
	let incompleteBatches = 0;
	for (const batch of batches) {
		const userNames = batch.map((identity) => identity.twitterUserName);
		const batchSources = batch.flatMap((identity) => identity.sources);
		const sinceTime = calculateMonitoringSinceTime(batchSources);
		const { tweets, completed } = await fetchTweetsForBatch(env.KAITO_API_KEY, userNames, sinceTime);
		const saved = await saveTweetGroups(env, tweets);
		processed += saved.processed;
		if (!completed || saved.hasUnattributedFailure) {
			incompleteBatches++;
			continue;
		}

		const completedSourceIds = batch
			.filter((identity) => !saved.failedUserNames.has(identity.twitterUserName))
			.flatMap((identity) => identity.sources.map((source) => source.id));
		await markSourcesScraped(env, completedSourceIds, runStartedAt);
		advancedSources += completedSourceIds.length;
	}
	return { processed, advancedSources, incompleteBatches };
}

export async function handleTwitterCron(env: CoreEnv): Promise<void> {
	if (!env.KAITO_API_KEY) {
		console.info({ tag: 'TWITTER', msg: 'Skipped - KAITO_API_KEY not configured' });
		return;
	}
	console.info({ tag: 'TWITTER', msg: 'start' });
	const runStartedAt = new Date();
	const users = await loadEnabledSources(env, 'twitter');
	if (!users.length) {
		console.info({ tag: 'TWITTER', msg: 'No twitter sources configured' });
		return;
	}

	const monitoredUsers = monitoredTwitterUsers(users);
	const identities = monitoredTwitterIdentities(monitoredUsers);
	if (identities.length === 0) {
		console.warn({ tag: 'TWITTER', msg: 'No valid twitter usernames in source feeds', users: users.length });
		return;
	}
	const batches = batchTwitterIdentities(identities);

	console.info({ tag: 'TWITTER', msg: 'Fetching via Advanced Search', users: identities.length, batches: batches.length });

	const { processed, advancedSources, incompleteBatches } = await processTwitterBatches(env, batches, runStartedAt);

	console.info({
		tag: 'TWITTER',
		msg: 'end',
		processed,
		users: users.length,
		validUsers: monitoredUsers.length,
		advancedSources,
		incompleteBatches,
		batches: batches.length,
	});
}

export async function processTwitterResource(resource: ResourceForProcessing, env: CoreEnv): Promise<ProcessorResult> {
	const updateData: ProcessorResult['updateData'] = {};
	const tweetText = resource.summary?.trim() || resource.content || '';
	if (isEmpty(resource.summary)) updateData.summary = tweetText;
	if (isEmpty(resource.content)) updateData.content = tweetText;
	const resourceForClassification = {
		...resource,
		summary: updateData.summary ?? resource.summary,
		content: updateData.content ?? resource.content,
	};
	console.info({ tag: 'TWITTER-PROCESSOR', msg: 'Classifying Twitter resource', title: resource.title.slice(0, 50) });
	const classification = await generateResourceClassification(resourceForClassification, env);
	const merged = mergeResourceClassification(resourceForClassification, classification, { updateData, extraTags: ['Twitter'] });
	return { updateData: merged.updateData, classificationCategory: merged.classificationCategory };
}
