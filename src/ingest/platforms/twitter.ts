import { generateObject } from '@core-ai/embedding';
import { ENTITY_TYPES, type PlatformMetadata, type ResourceForProcessing } from '@core-shared/types';
import { fetchWithTimeout, normalizeUrl, readTextWithLimit } from '@core-shared/web';
import { type CoreDb, withCoreDb } from '@db/client';
import { rssList } from '@db/schema';
import { entityExtractionExclusionNames } from '@entities/normalize';
import { getExistingResourcesByUrl, reopenResourceForReprocessing, upsertPendingSourceResource } from '@ingest/domain/resource-store';
import { enqueueProcessing } from '@ingest/workflow';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { ZH_HANT_RESOURCE_LANG } from '../../resources/types';
import { generateArticleAnalysis, isEmpty, mergeArticleAnalysis, type ProcessorResult } from '../domain/ai-utils';
import { buildThreadArticleParts, buildTweetTitle, resolveTweetContent, type Tweet } from './twitter-acquisition';

async function enqueueTwitterArticle(
	db: CoreDb,
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
	const resourceId = await upsertPendingSourceResource(db, {
		url: data.url,
		title: data.title,
		source: data.source,
		publishedDate: data.publishedDate,
		summary: data.summary,
		type: 'twitter',
		content: data.content,
		platformMetadata: data.platformMetadata,
		keywords: data.hashTags,
	});
	await enqueueProcessing(env, {
		kind: 'resource',
		rowId: resourceId,
	});
	return true;
}

const MIN_TWEET_LENGTH = 150;

async function saveTweet(db: CoreDb, tweet: Tweet, env: CoreEnv): Promise<boolean> {
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
	const [existingArticle] = await getExistingResourcesByUrl(db, [articleUrl]);
	if (existingArticle) {
		if (!existingArticle.hasZhHantSummary) await enqueueProcessing(env, { kind: 'resource', rowId: existingArticle.id });
		console.info({ tag: 'TWITTER', msg: 'Article already exists (dedup)', url: articleUrl, eventType: resolved.kind });
		return true;
	}

	const { scraped } = resolved;
	const title = scraped.title || buildTweetTitle(tweet);
	const source =
		resolved.kind === 'share'
			? scraped.metadata.siteName || scraped.metadata.author || 'External'
			: tweet.author?.name || scraped.metadata.author || 'Twitter';
	const queued = await enqueueTwitterArticle(db, env, {
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

async function saveThread(db: CoreDb, tweets: Tweet[], env: CoreEnv): Promise<boolean> {
	const { first, combinedText, platformMetadata } = buildThreadArticleParts(tweets);
	const firstUrl = normalizeUrl(first.url);
	const tweetCount = tweets.length;

	const [existing] = await getExistingResourcesByUrl(db, [firstUrl]);

	if (existing) {
		const existingId = existing.id;
		await reopenResourceForReprocessing(db, existingId, { summary: combinedText, content: combinedText, platformMetadata });
		await enqueueProcessing(env, { kind: 'resource', rowId: existingId });
		console.info({ tag: 'TWITTER', msg: 'Updated thread', author: first.author?.userName, tweets: tweetCount });
		return true;
	}

	const queued = await enqueueTwitterArticle(db, env, {
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
function calculateMonitoringSinceTime(users: Array<{ scraped_at?: Date | string | null }>): number {
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

async function saveTweetGroups(env: CoreEnv, db: CoreDb, tweets: Tweet[]): Promise<{ processed: number; allSaved: boolean }> {
	let processed = 0;
	let allSaved = true;
	for (const group of groupTweetsIntoThreads(tweets)) {
		const first = group[0];
		if (!first) continue;
		try {
			const saved = group.length >= 2 ? await saveThread(db, group, env) : await saveTweet(db, first, env);
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
		const saved = await withCoreDb(env, (db) => saveTweetGroups(env, db, tweets));
		processed += saved.processed;
		if (!saved.allSaved) allCompleted = false;
	}
	return { processed, allCompleted };
}

async function markTwitterFeedsScraped(env: CoreEnv, users: MonitoredTwitterUser[]): Promise<void> {
	await withCoreDb(env, async (db) => {
		await db
			.update(rssList)
			.set({ scrapedAt: new Date() })
			.where(
				inArray(
					rssList.id,
					users.map((u) => u.id),
				),
			);
	});
}

export async function handleTwitterCron(env: CoreEnv): Promise<void> {
	console.info({ tag: 'TWITTER', msg: 'start' });
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
	if (allCompleted) await markTwitterFeedsScraped(env, monitoredUsers);

	console.info({
		tag: 'TWITTER',
		msg: 'end',
		processed,
		users: users.length,
		validUsers: monitoredUsers.length,
		batches: batches.length,
	});
}

export async function processTwitterArticle(article: ResourceForProcessing, env: CoreEnv): Promise<ProcessorResult> {
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
			content: isEmpty(article.content) ? tweetText : undefined,
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

async function translateTweet(tweetText: string, article: ResourceForProcessing, env: CoreEnv): Promise<TweetAnalysis | null> {
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
			summary: result.summary,
			tags: (result.tags.length ? result.tags : ['Twitter']).slice(0, 5),
			keywords: result.keywords.slice(0, 8),
			entities: Array.isArray(result.entities) ? result.entities.slice(0, 10) : [],
		};
	} catch (error) {
		console.error({ tag: 'AI', msg: 'Tweet translation failed', error: String(error) });
		return null;
	}
}
