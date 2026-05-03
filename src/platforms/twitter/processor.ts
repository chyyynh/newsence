// ─────────────────────────────────────────────────────────────
// Twitter Processor
// ─────────────────────────────────────────────────────────────

import {
	type ArticleProcessor,
	callGeminiForAnalysis,
	isEmpty,
	type ProcessorContext,
	type ProcessorResult,
} from '../../domain/processing/ai-utils';
import { logError, logInfo, logWarn } from '../../infra/log';
import { callOpenRouter, extractJson } from '../../infra/openrouter';
import type { AIAnalysisResult, Article } from '../../models/types';
import { scrapeWebPage } from '../web/scraper';

type UpdateData = ProcessorResult['updateData'];

/** Map a Gemini analysis result onto an article's pending update, only overwriting empty fields. */
function applyGeminiAnalysis(article: Article, analysis: AIAnalysisResult, updateData: UpdateData): void {
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

// ─────────────────────────────────────────────────────────────
// TwitterProcessor class
// ─────────────────────────────────────────────────────────────

export class TwitterProcessor implements ArticleProcessor {
	readonly sourceType = 'twitter';

	async process(article: Article, ctx: ProcessorContext): Promise<ProcessorResult> {
		const updateData: UpdateData = {};
		const hasFullContent = !isEmpty(article.content) && article.content!.length > 200;

		if (hasFullContent) {
			logInfo('TWITTER-PROCESSOR', 'Processing Twitter Article', { title: article.title.slice(0, 50) });
			const analysis = await callGeminiForAnalysis(article, ctx.env.OPENROUTER_API_KEY);
			applyGeminiAnalysis(article, analysis, updateData);
			return { updateData };
		}

		const tweetText = extractTweetText(article);
		if (isEmpty(article.summary)) updateData.summary = tweetText;

		const linkedUrl = this.extractLinkedUrl(tweetText);
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
			logInfo('TWITTER-PROCESSOR', 'Scraped linked article', { title: linked.title });
			updateData.content = linked.content;
			const analysis = await callGeminiForAnalysis(
				{ ...article, title: linked.title || article.title, content: linked.content, summary: linked.summary ?? null },
				ctx.env.OPENROUTER_API_KEY,
			);
			applyGeminiAnalysis(article, analysis, updateData);
			return true;
		} catch (e) {
			logWarn('TWITTER-PROCESSOR', 'Failed to scrape linked URL', { url: linkedUrl, error: String(e) });
			return false;
		}
	}

	private async applyPlainTweetAnalysis(tweetText: string, article: Article, ctx: ProcessorContext, updateData: UpdateData): Promise<void> {
		const analysis = await translateTweet(tweetText, ctx.env.OPENROUTER_API_KEY);
		if (isEmpty(article.summary_cn)) updateData.summary_cn = analysis.summary_cn;
		if (!article.tags?.length) updateData.tags = analysis.tags;
		if (!article.keywords?.length) updateData.keywords = analysis.keywords;
		if (analysis.entities?.length) updateData.entities = analysis.entities;
	}

	private extractLinkedUrl(tweetText: string): string | null {
		const textWithoutUrls = tweetText.replace(/https?:\/\/\S+/g, '').trim();
		if (textWithoutUrls.length > 50) return null;

		const urlMatch = tweetText.match(/https?:\/\/\S+/);
		if (urlMatch) {
			const url = urlMatch[0];
			if (/(?:twitter\.com|x\.com)/.test(url)) return null;
			return url;
		}
		return null;
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

export async function translateTweet(tweetText: string, apiKey: string): Promise<TweetAnalysis> {
	logInfo('AI', 'Translating tweet', { text: tweetText.substring(0, 60) });

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

	const rawContent = await callOpenRouter(prompt, { apiKey, maxTokens: 600 });
	if (!rawContent) return { ...TWEET_FALLBACK, summary_cn: tweetText };

	try {
		const result = extractJson<TweetAnalysis>(rawContent);
		if (!result) throw new Error('No JSON found');

		return {
			summary_cn: result.summary_cn ?? tweetText,
			tags: (result.tags ?? ['Twitter']).slice(0, 5),
			keywords: (result.keywords ?? []).slice(0, 8),
			entities: Array.isArray(result.entities) ? result.entities.slice(0, 10) : [],
		};
	} catch (error) {
		logError('AI', 'Tweet translation failed', { error: String(error) });
		return { ...TWEET_FALLBACK, summary_cn: tweetText };
	}
}
