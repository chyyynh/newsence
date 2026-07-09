import { generateObject } from '@core-ai/embedding';
import { ENTITY_TYPES, type PlatformMetadata, type ResourceForProcessing } from '@core-shared/types';
import { fetchWithTimeout, normalizeUrl, readTextWithLimit } from '@core-shared/web';
import { withCoreDb } from '@db/client';
import { rssList } from '@db/schema';
import { entityExtractionExclusionNames } from '@entities/normalize';
import { getExistingResourcesByUrl, reopenResourceForReprocessing, upsertPendingSourceResource } from '@ingest/domain/resource-store';
import { enqueueProcessing } from '@ingest/workflow';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { ZH_HANT_RESOURCE_LANG } from '../../resources/types';
import { generateResourceAnalysis, isEmpty, mergeResourceAnalysis, type ProcessorResult } from '../domain/ai-utils';
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
): Promise<boolean> {
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
	return true;
}

const MIN_TWEET_LENGTH = 150;

async function saveTweet(tweet: Tweet, env: CoreEnv): Promise<boolean> {
	const resolved = await resolveTweetContent(tweet, env.KAITO_API_KEY);

	if (resolved.kind === 'tweet' && !tweet.retweetedBy && resolved.eventText.length < MIN_TWEET_LENGTH) {
		console.info({ tag: 'TWITTER', msg: 'Filtered tweet', author: tweet.author?.userName, reason: 'too short standalone tweet' });
		return false;
	}

	const resourceUrl = normalizeUrl(resolved.canonicalUrl);
	const [existingResource] = await withCoreDb(env, (db) => getExistingResourcesByUrl(db, [resourceUrl]));
	if (existingResource) {
		if (existingResource.shouldRetryEnrichment) await enqueueProcessing(env, existingResource.id);
		console.info({ tag: 'TWITTER', msg: 'Resource already exists (dedup)', url: resourceUrl, eventType: resolved.kind });
		return true;
	}

	const { scraped } = resolved;
	const title = scraped.title || buildTweetTitle(tweet);
	const source =
		resolved.kind === 'share'
			? scraped.metadata.siteName || scraped.metadata.author || 'External'
			: tweet.author?.name || scraped.metadata.author || 'Twitter';
	const queued = await enqueueTwitterResource(env, {
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
	if (queued) console.info({ tag: 'TWITTER', msg: 'Saved tweet content', kind: resolved.kind, title: title.slice(0, 50) });
	return queued;
}

async function saveThread(tweets: Tweet[], env: CoreEnv): Promise<boolean> {
	const { first, combinedText, platformMetadata } = buildThreadResourceParts(tweets);
	const firstUrl = normalizeUrl(first.url);
	const tweetCount = tweets.length;

	const [existing] = await withCoreDb(env, (db) => getExistingResourcesByUrl(db, [firstUrl]));

	if (existing) {
		const existingId = existing.id;
		const changed = await withCoreDb(env, (db) =>
			reopenResourceForReprocessing(db, existingId, { summary: combinedText, content: combinedText, platformMetadata }),
		);
		if (changed || existing.shouldRetryEnrichment) await enqueueProcessing(env, existingId);
		console.info({
			tag: 'TWITTER',
			msg: changed ? 'Updated thread' : 'Thread unchanged',
			author: first.author?.userName,
			tweets: tweetCount,
		});
		return true;
	}

	const queued = await enqueueTwitterResource(env, {
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

	if (queued) {
		console.info({ tag: 'TWITTER', msg: 'Saved thread', author: first.author?.userName, tweets: tweetCount });
	}
	return queued;
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

/**
 * Global sinceTime = oldest effective watermark across all users minus a 1h
 * overlap. A missing or invalid per-user watermark falls back to 24h ago.
 */
function calculateMonitoringSinceTime(users: Array<{ scraped_at?: Date | string | null }>): number {
	const fallback = Date.now() - TWITTER_INITIAL_LOOKBACK_MS;
	let oldest = Number.POSITIVE_INFINITY;
	for (const user of users) {
		const timestamp = user.scraped_at ? new Date(user.scraped_at).getTime() : Number.NaN;
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

type TwitterSourceFeed = {
	id: number;
	RSSLink: string | null;
	scraped_at: Date | null;
};

type MonitoredTwitterUser = TwitterSourceFeed & { twitterUserName: string };

async function loadTwitterSourceFeeds(env: CoreEnv): Promise<TwitterSourceFeed[]> {
	return withCoreDb(env, async (db) =>
		db
			.select({ id: rssList.id, RSSLink: rssList.rssLink, scraped_at: rssList.scrapedAt })
			.from(rssList)
			.where(eq(rssList.type, 'twitter_user')),
	);
}

function monitoredTwitterUsers(users: TwitterSourceFeed[]): MonitoredTwitterUser[] {
	return users.flatMap((user) => {
		const twitterUserName = normalizeTwitterUserName(user.RSSLink);
		return twitterUserName ? [{ ...user, twitterUserName }] : [];
	});
}

function batchTwitterUserNames(userNames: string[]): string[][] {
	const batches: string[][] = [];
	for (let i = 0; i < userNames.length; i += TWITTER_BATCH_SIZE) {
		batches.push(userNames.slice(i, i + TWITTER_BATCH_SIZE));
	}
	return batches;
}

async function saveTweetGroups(env: CoreEnv, tweets: Tweet[]): Promise<{ processed: number; allSaved: boolean }> {
	let processed = 0;
	let allSaved = true;
	for (const group of groupTweetsIntoThreads(tweets)) {
		const first = group[0];
		if (!first) continue;
		try {
			const saved = group.length >= 2 ? await saveThread(group, env) : await saveTweet(first, env);
			if (saved) processed++;
		} catch (err) {
			allSaved = false;
			console.error({ tag: 'TWITTER', msg: 'Save failed', url: first.url, error: String(err) });
		}
	}
	return { processed, allSaved };
}

async function processTwitterBatches(
	env: CoreEnv,
	batches: string[][],
	sinceTime: number,
): Promise<{ processed: number; allCompleted: boolean }> {
	let processed = 0;
	let allCompleted = true;
	for (const batch of batches) {
		const { tweets, completed } = await fetchTweetsForBatch(env.KAITO_API_KEY, batch, sinceTime);
		if (!completed) allCompleted = false;
		const saved = await saveTweetGroups(env, tweets);
		processed += saved.processed;
		if (!saved.allSaved) allCompleted = false;
	}
	return { processed, allCompleted };
}

async function markTwitterFeedsScraped(env: CoreEnv, users: MonitoredTwitterUser[], scrapedAt: Date): Promise<void> {
	await withCoreDb(env, async (db) => {
		await db
			.update(rssList)
			.set({ scrapedAt })
			.where(
				inArray(
					rssList.id,
					users.map((u) => u.id),
				),
			);
	});
}

export async function handleTwitterCron(env: CoreEnv): Promise<void> {
	if (!env.KAITO_API_KEY) {
		console.info({ tag: 'TWITTER', msg: 'Skipped - KAITO_API_KEY not configured' });
		return;
	}
	console.info({ tag: 'TWITTER', msg: 'start' });
	const runStartedAt = new Date();
	const users = await loadTwitterSourceFeeds(env);
	if (!users.length) {
		console.info({ tag: 'TWITTER', msg: 'No twitter_user source feeds configured' });
		return;
	}

	const monitoredUsers = monitoredTwitterUsers(users);
	const userNames = [...new Set(monitoredUsers.map((u) => u.twitterUserName))];
	if (userNames.length === 0) {
		console.warn({ tag: 'TWITTER', msg: 'No valid twitter usernames in source feeds', users: users.length });
		return;
	}
	const sinceTime = calculateMonitoringSinceTime(monitoredUsers);
	const batches = batchTwitterUserNames(userNames);

	console.info({ tag: 'TWITTER', msg: 'Fetching via Advanced Search', users: userNames.length, batches: batches.length, sinceTime });

	const { processed, allCompleted } = await processTwitterBatches(env, batches, sinceTime);
	if (allCompleted) await markTwitterFeedsScraped(env, monitoredUsers, runStartedAt);

	console.info({
		tag: 'TWITTER',
		msg: 'end',
		processed,
		users: users.length,
		validUsers: monitoredUsers.length,
		batches: batches.length,
	});
}

export async function processTwitterResource(resource: ResourceForProcessing, env: CoreEnv): Promise<ProcessorResult> {
	const updateData: ProcessorResult['updateData'] = {};
	const hasFullContent = !isEmpty(resource.content) && resource.content!.length > 200;

	if (hasFullContent) {
		console.info({ tag: 'TWITTER-PROCESSOR', msg: 'Processing Twitter resource', title: resource.title.slice(0, 50) });
		const analysis = await generateResourceAnalysis(resource, env);
		return mergeResourceAnalysis(resource, analysis, { updateData });
	}

	const tweetText = resource.summary?.trim() || resource.content || '';
	if (isEmpty(resource.summary)) updateData.summary = tweetText;

	const analysis = await translateTweet(tweetText, resource, env);
	const merged = mergeResourceAnalysis(
		resource,
		{
			content: isEmpty(resource.content) ? tweetText : undefined,
			translations: {
				[ZH_HANT_RESOURCE_LANG]: {
					title: analysis.summary.slice(0, 80),
					summary: analysis.summary,
					content: analysis.summary,
					source: 'machine',
				},
			},
			tags: analysis.tags,
			keywords: analysis.keywords,
			entities: analysis.entities,
		},
		{ updateData },
	);
	return { updateData: merged.updateData, classificationCategory: merged.classificationCategory };
}

const TweetAnalysisSchema = z.object({
	summary: z.string().min(1),
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
- summary 是忠實翻譯，不是評論或摘要

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

async function translateTweet(tweetText: string, resource: ResourceForProcessing, env: CoreEnv): Promise<TweetAnalysis> {
	console.info({ tag: 'AI', msg: 'Translating tweet', text: tweetText.substring(0, 60) });
	const excludedEntities = entityExtractionExclusionNames(resource.type, resource.source, resource.platform_metadata);
	const excludedLine = excludedEntities.length ? `\n實體排除名單: ${excludedEntities.join(', ')}` : '';

	try {
		const result = await generateObject<TweetAnalysis>(
			env.AI,
			`推文來源: ${resource.source}${excludedLine}
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
		if (!result) throw new Error('Tweet translation did not return valid output');

		return {
			summary: result.summary,
			tags: (result.tags.length ? result.tags : ['Twitter']).slice(0, 5),
			keywords: result.keywords.slice(0, 8),
			entities: Array.isArray(result.entities) ? result.entities.slice(0, 10) : [],
		};
	} catch (error) {
		console.error({ tag: 'AI', msg: 'Tweet translation failed', error: String(error) });
		throw error;
	}
}
