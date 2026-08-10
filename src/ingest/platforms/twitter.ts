import { fetchWithTimeout, readTextWithLimit } from '@core-shared/http';
import type { PlatformMetadata } from '@core-shared/types';
import { normalizeUrl } from '@core-shared/url';
import { withCoreDb, withCoreTx } from '@db/client';
import {
	attachSourceToResources,
	getExistingResourcesByUrl,
	reopenResourceForReprocessing,
	upsertPendingSourceResource,
} from '@ingest/domain/resource-store';
import { loadMonitoredSources, type MonitoredSource, markSourcesScraped, recordSourceFailure } from '@ingest/domain/source-store';
import { enqueueProcessing } from '@ingest/workflow';
import { buildThreadResourceParts, buildTweetTitle, resolveTweetContent, type Tweet } from './twitter-acquisition';

async function enqueueTwitterResource(
	env: CoreEnv,
	data: {
		sourceId: string;
		url: string;
		title: string;
		source: string;
		publishedDate: Date;
		originalLang?: string;
		content: string | null;
		platformMetadata: PlatformMetadata;
		previewImageUrl?: string | null;
		hashTags?: string[];
	},
): Promise<void> {
	const pending = await withCoreTx(env, (db) =>
		upsertPendingSourceResource(db, {
			sourceId: data.sourceId,
			url: data.url,
			title: data.title,
			source: data.source,
			publishedDate: data.publishedDate,
			summary: null,
			kind: 'post',
			resourcePlatform: 'twitter',
			originalLang: data.originalLang,
			content: data.content,
			platformMetadata: data.platformMetadata,
			previewImageUrl: data.previewImageUrl,
			keywords: data.hashTags,
		}),
	);
	if (pending.needsProcessing) {
		await enqueueProcessing(env, pending.resourceId, pending.sourceRevision ?? undefined);
	}
}

const MIN_TWEET_LENGTH = 150;

function requiredTweetText(value: string | null | undefined, field: string, tweetId: string): string {
	const text = value?.trim();
	if (!text) throw new Error(`Tweet ${tweetId} is missing ${field}`);
	return text;
}

function requiredTweetDate(value: string | null, tweetId: string): Date {
	if (!value) throw new Error(`Tweet ${tweetId} is missing publishedDate`);
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) throw new Error(`Tweet ${tweetId} has invalid publishedDate`);
	return date;
}

async function reuseExistingTweet(env: CoreEnv, url: string, sourceId: string): Promise<boolean> {
	const [existing] = await withCoreDb(env, (db) => getExistingResourcesByUrl(db, [url]));
	if (!existing) return false;
	await withCoreDb(env, (db) => attachSourceToResources(db, [existing.id], sourceId));
	if (existing.shouldRetryEnrichment) await enqueueProcessing(env, existing.id);
	console.info({ tag: 'TWITTER', msg: 'Resource already exists (dedup)', url });
	return true;
}

async function saveTweet(tweet: Tweet, env: CoreEnv, monitoredSource: MonitoredSource): Promise<boolean> {
	let knownUrl: string | null = null;
	try {
		knownUrl = tweet.url ? normalizeUrl(tweet.url) : null;
	} catch {
		// Let content resolution surface a useful error for malformed API data.
	}
	if (knownUrl && (await reuseExistingTweet(env, knownUrl, monitoredSource.id))) return true;

	const resolved = await resolveTweetContent(tweet, env.KAITO_API_KEY);

	if (resolved.kind === 'tweet' && !tweet.retweetedBy && resolved.eventText.length < MIN_TWEET_LENGTH) {
		console.info({ tag: 'TWITTER', msg: 'Filtered tweet', author: tweet.author?.userName, reason: 'too short standalone tweet' });
		return false;
	}

	const resourceUrl = normalizeUrl(resolved.canonicalUrl);
	if (resourceUrl !== knownUrl && (await reuseExistingTweet(env, resourceUrl, monitoredSource.id))) return true;

	const { scraped } = resolved;
	const tweetId = tweet.id ?? resourceUrl;
	const title = requiredTweetText(scraped.title, 'title', tweetId);
	const source = requiredTweetText(scraped.metadata.siteName, 'siteName', tweetId);
	await enqueueTwitterResource(env, {
		sourceId: monitoredSource.id,
		url: resourceUrl,
		title,
		source,
		publishedDate: requiredTweetDate(scraped.metadata.publishedDate, tweetId),
		originalLang: scraped.metadata.language ?? undefined,
		content: scraped.markdown,
		platformMetadata: scraped.platformMetadata,
		previewImageUrl: scraped.previewImageUrl,
		hashTags: tweet.hashTags,
	});
	console.info({ tag: 'TWITTER', msg: 'Saved tweet content', kind: resolved.kind, title: title.slice(0, 50) });
	return true;
}

async function saveThread(tweets: Tweet[], env: CoreEnv, monitoredSource: MonitoredSource): Promise<boolean> {
	const { first, combinedText, platformMetadata } = buildThreadResourceParts(tweets);
	const firstUrl = normalizeUrl(first.url);
	const tweetCount = tweets.length;

	const [existing] = await withCoreDb(env, (db) => getExistingResourcesByUrl(db, [firstUrl]));

	if (existing) {
		const existingId = existing.id;
		await withCoreDb(env, (db) => attachSourceToResources(db, [existingId], monitoredSource.id));
		const sourceRevision = await reopenResourceForReprocessing(env, existingId, {
			content: combinedText,
			platformMetadata,
		});
		if (sourceRevision || existing.shouldRetryEnrichment) {
			await enqueueProcessing(env, existingId, sourceRevision ?? undefined);
		}
		console.info({
			tag: 'TWITTER',
			msg: sourceRevision ? 'Updated thread' : 'Thread unchanged',
			author: first.author?.userName,
			tweets: tweetCount,
		});
		return true;
	}

	await enqueueTwitterResource(env, {
		sourceId: monitoredSource.id,
		url: firstUrl,
		title: buildTweetTitle(first),
		source: first.author.name,
		publishedDate: new Date(first.createdAt),
		originalLang: first.lang,
		content: combinedText,
		platformMetadata,
		previewImageUrl: platformMetadata.data.media?.[0]?.url ?? null,
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
const TWITTER_WATERMARK_OVERLAP_MS = 60 * 60 * 1000;

function normalizeRetweet(tweet: Tweet): Tweet | null {
	if (tweet.retweeted_tweet) {
		const retweeter = tweet.author;
		if (!retweeter?.name.trim() || !retweeter.userName.trim()) {
			throw new Error(`Retweet ${tweet.id ?? tweet.url} has no complete author`);
		}
		const normalized = {
			...tweet.retweeted_tweet,
			retweetedBy: {
				tweetId: tweet.id,
				tweetUrl: tweet.url,
				retweetedAt: tweet.createdAt,
				authorName: retweeter.name,
				authorUserName: retweeter.userName,
				authorProfilePicture: retweeter.profilePicture,
				authorVerified: retweeter.isBlueVerified,
			},
		};
		if (!normalized.author?.name.trim() || !normalized.author.userName.trim()) {
			throw new Error(`Retweeted tweet ${normalized.id ?? normalized.url} has no complete author`);
		}
		return normalized;
	}
	if (tweet.text.startsWith('RT @')) return null;
	if (!tweet.author?.name.trim() || !tweet.author.userName.trim()) {
		throw new Error(`Tweet ${tweet.id ?? tweet.url} has no complete author`);
	}
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
function calculateMonitoringSinceTime(users: Array<{ scrapedAt?: Date | string | null; createdAt: Date | string }>): number {
	let oldest = Number.POSITIVE_INFINITY;
	for (const user of users) {
		const watermark = user.scrapedAt === null || user.scrapedAt === undefined ? user.createdAt : user.scrapedAt;
		const timestamp = new Date(watermark).getTime();
		if (!Number.isFinite(timestamp)) throw new Error('Twitter source has an invalid monitoring watermark');
		oldest = Math.min(oldest, timestamp);
	}
	if (!Number.isFinite(oldest)) throw new Error('Cannot calculate a Twitter watermark for an empty batch');
	return Math.floor((oldest - TWITTER_WATERMARK_OVERLAP_MS) / 1000);
}

type TwitterBatchFetch = {
	tweets: Tweet[];
	failedUserNames: Set<string>;
	hasUnattributedFailure: boolean;
};

function normalizeFetchedTweets(tweets: Tweet[], monitoredUserNames: ReadonlySet<string>): TwitterBatchFetch {
	const normalizedTweets: Tweet[] = [];
	const failedUserNames = new Set<string>();
	let hasUnattributedFailure = false;
	for (const tweet of tweets) {
		try {
			const normalized = normalizeRetweet(tweet);
			if (normalized) normalizedTweets.push(normalized);
		} catch (error) {
			const userName = tweet.author?.userName.trim().toLowerCase();
			if (userName && monitoredUserNames.has(userName)) failedUserNames.add(userName);
			else hasUnattributedFailure = true;
			console.error({
				tag: 'TWITTER',
				msg: 'Tweet normalization failed',
				tweetId: tweet.id,
				userName: userName || undefined,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { tweets: normalizedTweets, failedUserNames, hasUnattributedFailure };
}

/** Fetch all tweets matching `(from:u1 OR from:u2 …) since_time:<unix>`, paginating through cursors. */
async function fetchTweetsForBatch(apiKey: string, userNames: string[], sinceTime: number): Promise<TwitterBatchFetch> {
	const fromClause = userNames.map((u) => `from:${u}`).join(' OR ');
	const query = `(${fromClause}) since_time:${sinceTime}`;
	const monitoredUserNames = new Set(userNames);

	const tweets: Tweet[] = [];
	const failedUserNames = new Set<string>();
	let hasUnattributedFailure = false;
	let cursor = '';
	const seenCursors = new Set<string>();

	while (true) {
		const params = new URLSearchParams({ query, queryType: 'Latest' });
		if (cursor) params.set('cursor', cursor);

		const response = await fetchWithTimeout(
			`${TWITTER_ADVANCED_SEARCH_API}?${params}`,
			{ headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' } },
			20_000,
		);
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`Twitter Advanced Search failed with HTTP ${response.status}`);
		}
		const apiRes = JSON.parse(await readTextWithLimit(response, 2 * 1024 * 1024)) as {
			tweets?: Tweet[];
			has_next_page?: boolean;
			next_cursor?: string;
		};
		if (!Array.isArray(apiRes.tweets)) throw new Error('Twitter Advanced Search response omitted tweets');
		const normalizedPage = normalizeFetchedTweets(apiRes.tweets, monitoredUserNames);
		tweets.push(...normalizedPage.tweets);
		for (const userName of normalizedPage.failedUserNames) failedUserNames.add(userName);
		hasUnattributedFailure ||= normalizedPage.hasUnattributedFailure;

		if (typeof apiRes.has_next_page !== 'boolean') throw new Error('Twitter Advanced Search response omitted has_next_page');
		if (!apiRes.has_next_page) break;
		const nextCursor = apiRes.next_cursor?.trim();
		if (!nextCursor) throw new Error('Twitter Advanced Search response omitted the next cursor');
		cursor = nextCursor;
		if (seenCursors.has(cursor)) {
			throw new Error(`Twitter Advanced Search returned a repeated cursor: ${cursor.slice(0, 32)}`);
		}
		seenCursors.add(cursor);
		await scheduler.wait(1000);
	}

	return { tweets, failedUserNames, hasUnattributedFailure };
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

function requiredMonitoredTwitterSource(tweet: Tweet, identities: MonitoredTwitterIdentity[]): MonitoredSource {
	const userName = monitoredAuthorUserName(tweet);
	if (!userName) throw new Error(`Tweet ${tweet.id ?? tweet.url} has no monitored author identity`);
	const identity = identities.find((candidate) => candidate.twitterUserName === userName);
	if (!identity) throw new Error(`Tweet ${tweet.id ?? tweet.url} is not attributed to a monitored source`);
	if (identity.sources.length !== 1) {
		throw new Error(`Twitter identity @${userName} maps to ${identity.sources.length} Source rows`);
	}
	return identity.sources[0]!;
}

async function saveTweetGroups(env: CoreEnv, tweets: Tweet[], identities: MonitoredTwitterIdentity[]): Promise<TweetSaveResult> {
	let processed = 0;
	const failedUserNames = new Set<string>();
	let hasUnattributedFailure = false;
	for (const group of groupTweetsIntoThreads(tweets)) {
		const first = group[0];
		if (!first) continue;
		try {
			const monitoredSource = requiredMonitoredTwitterSource(first, identities);
			const saved = group.length >= 2 ? await saveThread(group, env, monitoredSource) : await saveTweet(first, env, monitoredSource);
			if (saved) processed++;
		} catch (error) {
			const userName = monitoredAuthorUserName(first);
			if (userName) failedUserNames.add(userName);
			else hasUnattributedFailure = true;
			console.error({
				tag: 'TWITTER',
				msg: 'Tweet group save failed',
				url: first.url,
				groupSize: group.length,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { processed, failedUserNames, hasUnattributedFailure };
}

// Per-user failures are attributable (unlike batch-level fetch errors), so
// they feed the same pending-validation lifecycle as RSS/YouTube.
async function settleFailedTwitterSources(env: CoreEnv, batch: MonitoredTwitterIdentity[], failedUserNames: Set<string>): Promise<void> {
	for (const identity of batch) {
		if (!failedUserNames.has(identity.twitterUserName)) continue;
		for (const source of identity.sources) {
			await recordSourceFailure(env, source.id, new Error(`Twitter fetch/persist failed for @${identity.twitterUserName}`));
		}
	}
}

type TwitterBatchOutcome = {
	processed: number;
	advancedSources: number;
	incomplete: boolean;
	systemFailures: unknown[];
};

async function settleTwitterBatch(
	env: CoreEnv,
	batch: MonitoredTwitterIdentity[],
	fetched: TwitterBatchFetch,
	saved: TweetSaveResult,
	runStartedAt: Date,
	userNames: string[],
): Promise<TwitterBatchOutcome> {
	if (fetched.hasUnattributedFailure || saved.hasUnattributedFailure) {
		return { processed: saved.processed, advancedSources: 0, incomplete: true, systemFailures: [] };
	}

	const failedUserNames = new Set([...fetched.failedUserNames, ...saved.failedUserNames]);
	await settleFailedTwitterSources(env, batch, failedUserNames);
	const completedSourceIds = batch
		.filter((identity) => !failedUserNames.has(identity.twitterUserName))
		.flatMap((identity) => identity.sources.map((source) => source.id));
	const incomplete = failedUserNames.size > 0;
	if (!completedSourceIds.length) {
		return { processed: saved.processed, advancedSources: 0, incomplete, systemFailures: [] };
	}

	try {
		await markSourcesScraped(env, completedSourceIds, runStartedAt);
		return {
			processed: saved.processed,
			advancedSources: completedSourceIds.length,
			incomplete,
			systemFailures: [],
		};
	} catch (error) {
		console.error({
			tag: 'TWITTER',
			msg: 'Twitter source watermark update failed',
			userNames,
			error: error instanceof Error ? error.message : String(error),
		});
		return { processed: saved.processed, advancedSources: 0, incomplete: true, systemFailures: [error] };
	}
}

async function processTwitterBatches(
	env: CoreEnv,
	batches: MonitoredTwitterIdentity[][],
	runStartedAt: Date,
): Promise<{ processed: number; advancedSources: number; incompleteBatches: number; systemFailures: unknown[] }> {
	let processed = 0;
	let advancedSources = 0;
	let incompleteBatches = 0;
	const systemFailures: unknown[] = [];
	for (const batch of batches) {
		const userNames = batch.map((identity) => identity.twitterUserName);
		const batchSources = batch.flatMap((identity) => identity.sources);
		let fetched: TwitterBatchFetch;
		try {
			const sinceTime = calculateMonitoringSinceTime(batchSources);
			fetched = await fetchTweetsForBatch(env.KAITO_API_KEY, userNames, sinceTime);
		} catch (error) {
			incompleteBatches++;
			systemFailures.push(error);
			console.error({
				tag: 'TWITTER',
				msg: 'Twitter batch fetch failed',
				userNames,
				error: error instanceof Error ? error.message : String(error),
			});
			continue;
		}

		const saved = await saveTweetGroups(env, fetched.tweets, batch);
		const outcome = await settleTwitterBatch(env, batch, fetched, saved, runStartedAt, userNames);
		processed += outcome.processed;
		advancedSources += outcome.advancedSources;
		if (outcome.incomplete) incompleteBatches++;
		systemFailures.push(...outcome.systemFailures);
	}
	return { processed, advancedSources, incompleteBatches, systemFailures };
}

export async function handleTwitterCron(env: CoreEnv): Promise<void> {
	if (!env.KAITO_API_KEY) throw new Error('KAITO_API_KEY is not configured');
	console.info({ tag: 'TWITTER', msg: 'start' });
	const runStartedAt = new Date();
	const users = await loadMonitoredSources(env, 'platform');
	if (!users.length) {
		console.info({ tag: 'TWITTER', msg: 'No twitter sources configured' });
		return;
	}

	const monitoredUsers = monitoredTwitterUsers(users);
	const validSourceIds = new Set(monitoredUsers.map((source) => source.id));
	const invalidSources = users.filter((source) => !validSourceIds.has(source.id));
	for (const source of invalidSources) {
		await recordSourceFailure(env, source.id, new Error('Twitter source has an invalid handle'));
	}
	const identities = monitoredTwitterIdentities(monitoredUsers);
	if (identities.length === 0) {
		console.warn({ tag: 'TWITTER', msg: 'No valid Twitter sources configured', invalidSources: invalidSources.length });
		return;
	}
	const batches = batchTwitterIdentities(identities);

	console.info({ tag: 'TWITTER', msg: 'Fetching via Advanced Search', users: identities.length, batches: batches.length });

	const { processed, advancedSources, incompleteBatches, systemFailures } = await processTwitterBatches(env, batches, runStartedAt);

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
	if (systemFailures.length) {
		throw new AggregateError(systemFailures, `${systemFailures.length} Twitter monitor batches failed`);
	}
}
