import { generateObject } from '@core-ai/embedding';
import type { TwitterMedia } from '@core-shared/platform-metadata';
import {
	type Article,
	ENTITY_TYPES,
	type Tweet,
	type TwitterSourceEventDraft,
	type TwitterSourceEventInputType,
	type WorkflowAttachment,
} from '@core-shared/types';
import { entityExtractionExclusionNames } from '@entities/normalize';
import type { Client } from 'pg';
import { z } from 'zod';
import {
	type ArticleProcessor,
	generateArticleAnalysis,
	isEmpty,
	mergeArticleAnalysis,
	type ProcessorContext,
	type ProcessorResult,
} from '../../domain/ai-utils';
import { extractTweetMedia, stripTweetUrls } from './scraper';

type UpdateData = ProcessorResult['updateData'];

type TwitterSourceEventType = TwitterSourceEventInputType | 'quote' | 'retweet';

async function upsertTwitterSourceEvent(
	db: Client,
	tweet: Tweet,
	options: {
		articleId: string | null;
		eventType: TwitterSourceEventInputType;
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
	let eventType: TwitterSourceEventType = options.eventType;
	if (tweet.retweetedBy) eventType = 'retweet';
	else if (eventType === 'tweet' && tweet.quoted_tweet) eventType = 'quote';
	const text = options.text ?? stripTweetUrls(tweet.text);
	const mediaAssets = options.media ?? extractTweetMedia(tweet);
	const raw = options.raw ?? tweet;

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
			JSON.stringify({
				viewCount: tweet.viewCount,
				likeCount: tweet.likeCount,
				retweetCount: tweet.retweetCount,
				replyCount: tweet.replyCount,
				quoteCount: tweet.quoteCount,
			}),
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
}

export async function upsertTwitterSourceEventDraft(db: Client, articleId: string, event: TwitterSourceEventDraft): Promise<void> {
	const { tweet, eventType, text, media, raw } = event;
	await upsertTwitterSourceEvent(db, tweet, { articleId, eventType, text, media, raw });
}

export async function upsertTwitterSourceEventAttachment(db: Client, articleId: string, attachments?: WorkflowAttachment[]): Promise<void> {
	for (const attachment of attachments ?? []) {
		if (attachment.kind === 'twitter-source-event') {
			await upsertTwitterSourceEventDraft(db, articleId, attachment.event);
			return;
		}
	}
}

export class TwitterProcessor implements ArticleProcessor {
	async process(article: Article, ctx: ProcessorContext): Promise<ProcessorResult> {
		const updateData: UpdateData = {};
		const hasFullContent = !isEmpty(article.content) && article.content!.length > 200;

		if (hasFullContent) {
			console.info({ tag: 'TWITTER-PROCESSOR', msg: 'Processing Twitter Article', title: article.title.slice(0, 50) });
			const analysis = await generateArticleAnalysis(article, ctx.env);
			return mergeArticleAnalysis(article, analysis, { updateData });
		}

		const tweetText = article.summary?.trim() || article.content || '';
		if (isEmpty(article.summary)) updateData.summary = tweetText;

		const analysis = await translateTweet(tweetText, article, ctx.env);
		if (!analysis) return { updateData: { ...updateData, ...(!article.tags?.length ? { tags: ['Twitter'] } : {}) } };
		Object.assign(updateData, {
			...(isEmpty(article.title_cn) ? { title_cn: analysis.summary_cn.slice(0, 80) } : {}),
			...(isEmpty(article.summary_cn) ? { summary_cn: analysis.summary_cn } : {}),
			...(isEmpty(article.content) ? { content: tweetText } : {}),
			...(isEmpty(article.content_cn) ? { content_cn: analysis.summary_cn } : {}),
			...(!article.tags?.length && analysis.tags.length ? { tags: analysis.tags } : {}),
			...(!article.keywords?.length && analysis.keywords.length ? { keywords: analysis.keywords } : {}),
			entities: analysis.entities,
		});
		return { updateData };
	}
}

interface TweetAnalysis {
	summary_cn: string;
	tags: string[];
	keywords: string[];
	entities: Array<{ name: string; name_cn: string; type: string }>;
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

async function translateTweet(tweetText: string, article: Article, env: ProcessorContext['env']): Promise<TweetAnalysis | null> {
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
