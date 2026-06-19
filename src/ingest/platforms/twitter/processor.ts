// ─────────────────────────────────────────────────────────────
// Twitter Processor
// ─────────────────────────────────────────────────────────────

import { generateJson } from '@shared/ai';
import type { AIAnalysisResult, Article } from '@shared/types';
import {
	type ArticleProcessor,
	generateArticleAnalysis,
	isEmpty,
	type ProcessorContext,
	type ProcessorResult,
} from '../../domain/ai-utils';
import { scrapeWebPage } from '../web/scraper';

type UpdateData = ProcessorResult['updateData'];

function applyArticleAnalysis(article: Article, analysis: AIAnalysisResult, updateData: UpdateData): void {
	if (isEmpty(article.title_cn)) updateData.title_cn = analysis.title_cn;
	if (isEmpty(article.summary)) updateData.summary = analysis.summary_en;
	if (isEmpty(article.summary_cn)) updateData.summary_cn = analysis.summary_cn;
	if (!article.tags?.length) updateData.tags = [...new Set([...analysis.tags, analysis.category])];
	if (!article.keywords?.length) updateData.keywords = analysis.keywords;
	if (analysis.entities?.length) updateData.entities = analysis.entities;
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
			const analysis = await generateArticleAnalysis(article, ctx.env.AI);
			applyArticleAnalysis(article, analysis, updateData);
			return { updateData };
		}

		const tweetText = extractTweetText(article);
		if (isEmpty(article.summary)) updateData.summary = tweetText;

		const linkedUrl = getLinkedUrl(article);
		if (linkedUrl && (await this.applyLinkedArticleAnalysis(article, ctx, linkedUrl, updateData))) {
			return { updateData };
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
	): Promise<boolean> {
		try {
			const linked = await scrapeWebPage(linkedUrl);
			if (!linked.content || linked.content.length <= 100) return false;
			console.info({ tag: 'TWITTER-PROCESSOR', msg: 'Scraped linked article', title: linked.title });
			updateData.content = linked.content;
			const analysis = await generateArticleAnalysis(
				{ ...article, title: linked.title || article.title, content: linked.content, summary: linked.summary ?? null },
				ctx.env.AI,
			);
			applyArticleAnalysis(article, analysis, updateData);
			return true;
		} catch (e) {
			console.warn({ tag: 'TWITTER-PROCESSOR', msg: 'Failed to scrape linked URL', url: linkedUrl, error: String(e) });
			return false;
		}
	}

	private async applyPlainTweetAnalysis(tweetText: string, article: Article, ctx: ProcessorContext, updateData: UpdateData): Promise<void> {
		const analysis = await translateTweet(tweetText, ctx.env.AI);
		if (isEmpty(article.summary_cn)) updateData.summary_cn = analysis.summary_cn;
		if (!article.tags?.length) updateData.tags = analysis.tags;
		if (!article.keywords?.length) updateData.keywords = analysis.keywords;
		if (analysis.entities?.length) updateData.entities = analysis.entities;
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

const TWEET_FALLBACK: TweetAnalysis = { summary_cn: '', tags: ['Twitter'], keywords: [], entities: [] };
const TWEET_ANALYSIS_SCHEMA = {
	type: 'object',
	properties: {
		summary_cn: { type: 'string' },
		tags: { type: 'array', items: { type: 'string' } },
		keywords: { type: 'array', items: { type: 'string' } },
		entities: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					name: { type: 'string' },
					name_cn: { type: 'string' },
					type: { type: 'string', enum: ['person', 'organization', 'product', 'technology', 'event'] },
				},
				required: ['name', 'name_cn', 'type'],
			},
		},
	},
	required: ['summary_cn', 'tags', 'keywords', 'entities'],
};

async function translateTweet(tweetText: string, ai: ProcessorContext['env']['AI']): Promise<TweetAnalysis> {
	console.info({ tag: 'AI', msg: 'Translating tweet', text: tweetText.substring(0, 60) });

	const prompt = `請將以下推文直接翻譯成繁體中文，並提供標籤和關鍵字。

翻譯規則：
- 直接翻譯原文，保持原文的第一人稱或語氣，不要改寫成第三人稱描述
- 不要用「這則推文」、「作者認為」、「該推文提到」等第三角度描述
- 不要使用任何 Markdown 格式（不要用 **粗體**、- 列表、# 標題等）
- 純文字翻譯，忠實呈現原文意思即可

推文內容：
${tweetText}

請以JSON格式回答：
{
  "summary_cn": "繁體中文直接翻譯",
  "tags": ["標籤1", "標籤2", "標籤3"],
  "keywords": ["關鍵字1", "關鍵字2", "關鍵字3"],
  "entities": [{"name": "English Name", "name_cn": "繁體中文名稱", "type": "person|organization|product|technology|event"}]
}

實體擷取規則：
- 從推文中提取重要的具名實體（人物、組織、產品、技術、事件）
- name 用英文, name_cn 用繁體中文

標籤規則：
- AI相關: AI, MachineLearning, DeepLearning, LLM, GenerativeAI
- 產品相關: Coding, Robotics, SoftwareDevelopment, API
- 產業應用: Tech, Finance, Healthcare, Gaming, Creative
- 事件類型: ProductLaunch, Research, Partnership, Announcement

請只回傳JSON，不要其他文字。`;

	try {
		const result = await generateJson<TweetAnalysis>(ai, prompt, { schema: TWEET_ANALYSIS_SCHEMA, maxTokens: 600 });
		if (!result) throw new Error('No JSON found');

		return {
			summary_cn: result.summary_cn ?? tweetText,
			tags: (result.tags ?? ['Twitter']).slice(0, 5),
			keywords: (result.keywords ?? []).slice(0, 8),
			entities: Array.isArray(result.entities) ? result.entities.slice(0, 10) : [],
		};
	} catch (error) {
		console.error({ tag: 'AI', msg: 'Tweet translation failed', error: String(error) });
		return { ...TWEET_FALLBACK, summary_cn: tweetText };
	}
}
