// ─────────────────────────────────────────────────────────────
// Twitter Processor
// ─────────────────────────────────────────────────────────────

import { AI_TASKS, generateObject } from '@core-shared/ai';
import { entityExtractionExclusionNames } from '@core-shared/entities/normalize';
import type { ArticleCategory } from '@core-shared/platform-metadata';
import { type AIAnalysisResult, type Article, ENTITY_TYPES } from '@core-shared/types';
import { z } from 'zod';
import {
	type ArticleProcessor,
	generateArticleAnalysis,
	isEmpty,
	type ProcessorContext,
	type ProcessorResult,
} from '../../domain/ai-utils';
import { scrapeWebPage } from '../web-scraper';

type UpdateData = ProcessorResult['updateData'];
type LinkedArticleAnalysisResult = { applied: false } | { applied: true; category?: ArticleCategory };

function applyArticleAnalysis(article: Article, analysis: AIAnalysisResult, updateData: UpdateData): ArticleCategory | undefined {
	if (isEmpty(article.title_cn) && analysis.title_cn) updateData.title_cn = analysis.title_cn;
	if (isEmpty(article.summary) && analysis.summary_en) updateData.summary = analysis.summary_en;
	if (isEmpty(article.summary_cn) && analysis.summary_cn) updateData.summary_cn = analysis.summary_cn;
	if (analysis.content) updateData.content = analysis.content;
	if (isEmpty(article.content_cn) && analysis.content_cn) updateData.content_cn = analysis.content_cn;
	const allTags = [...new Set([...(analysis.tags ?? []), ...(analysis.category ? [analysis.category] : [])])];
	if (!article.tags?.length && allTags.length) updateData.tags = allTags;
	if (!article.keywords?.length && analysis.keywords?.length) updateData.keywords = analysis.keywords;
	if (analysis.entities) updateData.entities = analysis.entities;
	return analysis.category;
}

function extractTweetText(article: Article): string {
	const fromSummary = article.summary?.trim();
	if (fromSummary) return fromSummary;
	const raw = article.content ?? '';
	try {
		const parsed = JSON.parse(raw);
		if (parsed?.text) return parsed.text;
	} catch {
		// Not JSON, use raw as-is
	}
	return raw;
}

function getLinkedUrl(article: Article): string | null {
	const metadata = article.platform_metadata;
	if (metadata?.type !== 'twitter' || metadata.data.variant !== 'shared') return null;
	return metadata.data.externalUrl?.trim() || null;
}

// ─────────────────────────────────────────────────────────────
// TwitterProcessor class
// ─────────────────────────────────────────────────────────────

export class TwitterProcessor implements ArticleProcessor {
	async process(article: Article, ctx: ProcessorContext): Promise<ProcessorResult> {
		const updateData: UpdateData = {};
		const hasFullContent = !isEmpty(article.content) && article.content!.length > 200;

		if (hasFullContent) {
			console.info({ tag: 'TWITTER-PROCESSOR', msg: 'Processing Twitter Article', title: article.title.slice(0, 50) });
			const analysis = await generateArticleAnalysis(article, ctx.env);
			return { updateData, classificationCategory: applyArticleAnalysis(article, analysis, updateData) };
		}

		const tweetText = extractTweetText(article);
		if (isEmpty(article.summary)) updateData.summary = tweetText;

		const linkedUrl = getLinkedUrl(article);
		const linkedAnalysis: LinkedArticleAnalysisResult = linkedUrl
			? await this.applyLinkedArticleAnalysis(article, ctx, linkedUrl, updateData)
			: { applied: false };
		if (linkedAnalysis.applied) {
			return { updateData, classificationCategory: linkedAnalysis.category };
		}

		await this.applyPlainTweetAnalysis(tweetText, article, ctx, updateData);
		return { updateData };
	}

	/** Returns true if the linked article was usable and analysis was applied. */
	private async applyLinkedArticleAnalysis(
		article: Article,
		ctx: ProcessorContext,
		linkedUrl: string,
		updateData: UpdateData,
	): Promise<LinkedArticleAnalysisResult> {
		try {
			const linked = await scrapeWebPage(linkedUrl);
			if (!linked.content || linked.content.length <= 100) return { applied: false };
			console.info({ tag: 'TWITTER-PROCESSOR', msg: 'Scraped linked article', title: linked.title });
			updateData.content = linked.content;
			const analysis = await generateArticleAnalysis(
				{ ...article, title: linked.title || article.title, content: linked.content, summary: linked.summary ?? null },
				ctx.env,
			);
			return { applied: true, category: applyArticleAnalysis(article, analysis, updateData) };
		} catch (e) {
			console.warn({ tag: 'TWITTER-PROCESSOR', msg: 'Failed to scrape linked URL', url: linkedUrl, error: String(e) });
			return { applied: false };
		}
	}

	private async applyPlainTweetAnalysis(tweetText: string, article: Article, ctx: ProcessorContext, updateData: UpdateData): Promise<void> {
		const analysis = await translateTweet(tweetText, article, ctx.env);
		if (!analysis) {
			if (!article.tags?.length) updateData.tags = ['Twitter'];
			return;
		}
		if (isEmpty(article.title_cn)) updateData.title_cn = analysis.summary_cn.slice(0, 80);
		if (isEmpty(article.summary_cn)) updateData.summary_cn = analysis.summary_cn;
		if (isEmpty(article.content)) updateData.content = tweetText;
		if (isEmpty(article.content_cn)) updateData.content_cn = analysis.summary_cn;
		if (!article.tags?.length && analysis.tags.length) updateData.tags = analysis.tags;
		if (!article.keywords?.length && analysis.keywords.length) updateData.keywords = analysis.keywords;
		updateData.entities = analysis.entities;
	}
}

// ─────────────────────────────────────────────────────────────
// Tweet Translation
// ─────────────────────────────────────────────────────────────

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

function buildTweetContextPrompt(tweetText: string, article: Article): string {
	const excludedEntities = entityExtractionExclusionNames(article.source, article.platform_metadata);
	const excludedLine = excludedEntities.length ? `\n實體排除名單: ${excludedEntities.join(', ')}` : '';
	return `推文來源: ${article.source}${excludedLine}
推文內容：
${tweetText}`;
}

async function translateTweet(tweetText: string, article: Article, env: ProcessorContext['env']): Promise<TweetAnalysis | null> {
	console.info({ tag: 'AI', msg: 'Translating tweet', text: tweetText.substring(0, 60) });

	try {
		const result = await generateObject<TweetAnalysis>(env.AI, buildTweetContextPrompt(tweetText, article), {
			schema: TweetAnalysisSchema,
			schemaName: 'tweet analysis',
			task: AI_TASKS.tweetAnalysis,
			gatewayId: env.AI_GATEWAY_NAME,
			maxTokens: 600,
			systemPrompt: TWEET_ANALYSIS_SYSTEM_PROMPT,
		});
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
