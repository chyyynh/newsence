import { fetchWithTimeout, readTextWithLimit } from '@core-shared/web';
import { Client } from 'pg';
import { saveThread, saveTweet } from './persistence';
import type { Tweet } from './scraper';

// ─────────────────────────────────────────────────────────────
// Twitter Monitor
// ─────────────────────────────────────────────────────────────

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

export async function handleTwitterCron(env: Env): Promise<void> {
	console.info({ tag: 'TWITTER', msg: 'start' });
	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	try {
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
	} finally {
		await db.end();
	}
}
