import { Article, Env } from './types';
import { callGeminiForAnalysis, callOpenRouter, AI_MODELS, translateTweet } from './utils/ai';
import { HN_ALGOLIA_API } from './utils/platform';
import { scrapeWebPage } from './scrapers';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface ProcessorResult {
	updateData: {
		tags?: string[];
		keywords?: string[];
		title_cn?: string;
		summary?: string;
		summary_cn?: string;
		content?: string;
		content_cn?: string;
		title?: string;
	};
	enrichments?: Record<string, any>;
}

export interface ProcessorContext {
	env: Env;
	supabase: any;
	table: string;
}

export interface ArticleProcessor {
	readonly sourceType: string;
	process(article: Article, ctx: ProcessorContext): Promise<ProcessorResult>;
}

// ─────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────

export function isEmpty(value: string | null | undefined): boolean {
	return !value?.trim();
}

export async function callOpenRouterChat(
	apiKey: string,
	systemPrompt: string,
	userPrompt: string,
	maxTokens = 500
): Promise<string | null> {
	return callOpenRouter(userPrompt, {
		apiKey,
		model: AI_MODELS.FLASH,
		maxTokens,
		systemPrompt,
	});
}

// ─────────────────────────────────────────────────────────────
// Default Processor
// ─────────────────────────────────────────────────────────────

class DefaultProcessor implements ArticleProcessor {
	readonly sourceType = 'default';

	async process(article: Article, ctx: ProcessorContext): Promise<ProcessorResult> {
		const analysis = await callGeminiForAnalysis(article, ctx.env.OPENROUTER_API_KEY);
		const updateData: ProcessorResult['updateData'] = {};

		const allTags = [...new Set([...analysis.tags, analysis.category])];

		if (!article.tags?.length) updateData.tags = allTags;
		if (!article.keywords?.length) updateData.keywords = analysis.keywords;
		if (isEmpty(article.title_cn)) updateData.title_cn = analysis.title_cn;
		if (isEmpty(article.summary)) updateData.summary = analysis.summary_en;
		if (isEmpty(article.summary_cn)) updateData.summary_cn = analysis.summary_cn;
		if (analysis.title_en && !article.title_cn) updateData.title = analysis.title_en;

		return { updateData };
	}
}

// ─────────────────────────────────────────────────────────────
// Twitter Processor
// ─────────────────────────────────────────────────────────────

class TwitterProcessor implements ArticleProcessor {
	readonly sourceType = 'twitter';

	async process(article: Article, ctx: ProcessorContext): Promise<ProcessorResult> {
		const updateData: ProcessorResult['updateData'] = {};
		const metadata = article.platform_metadata?.data as Record<string, any> | undefined;
		const isArticle = article.platform_metadata?.type === 'twitter_article';

		// 1. Twitter Article — content is already full text from scrapeTwitterArticle
		if (isArticle && article.content && article.content.length > 200) {
			console.log(`[TWITTER-PROCESSOR] Processing Twitter Article: ${article.title.slice(0, 50)}`);
			const analysis = await callGeminiForAnalysis(article, ctx.env.OPENROUTER_API_KEY);

			if (isEmpty(article.title_cn)) updateData.title_cn = analysis.title_cn;
			if (isEmpty(article.summary)) updateData.summary = analysis.summary_en;
			if (isEmpty(article.summary_cn)) updateData.summary_cn = analysis.summary_cn;
			if (!article.tags?.length) updateData.tags = [...new Set([...analysis.tags, analysis.category])];
			if (!article.keywords?.length) updateData.keywords = analysis.keywords;

			// Translate full article content to Chinese
			const contentCn = await this.translateContent(article.content, ctx.env.OPENROUTER_API_KEY);
			if (contentCn) updateData.content_cn = contentCn;

			return { updateData };
		}

		// 2. Extract actual tweet text (prefer summary over full markdown content)
		let tweetText = article.summary?.trim() || '';
		if (!tweetText) {
			tweetText = article.content ?? '';
			try {
				const parsed = JSON.parse(tweetText);
				if (parsed.text) tweetText = parsed.text;
			} catch {
				// Not JSON, use as-is
			}
		}

		if (isEmpty(article.summary)) updateData.summary = tweetText;

		// 3. Tweet with external link — scrape linked article for analysis
		const linkedUrl = this.extractLinkedUrl(tweetText);
		if (linkedUrl) {
			try {
				const linked = await scrapeWebPage(linkedUrl);
				if (linked.content && linked.content.length > 100) {
					console.log(`[TWITTER-PROCESSOR] Scraped linked article: ${linked.title}`);
					updateData.content = linked.content;

					const analysis = await callGeminiForAnalysis(
						{ ...article, title: linked.title || article.title, content: linked.content, summary: linked.summary ?? null },
						ctx.env.OPENROUTER_API_KEY,
					);
					if (isEmpty(article.title_cn)) updateData.title_cn = analysis.title_cn;
					if (isEmpty(article.summary)) updateData.summary = analysis.summary_en;
					if (isEmpty(article.summary_cn)) updateData.summary_cn = analysis.summary_cn;
					if (!article.tags?.length) updateData.tags = [...new Set([...analysis.tags, analysis.category])];
					if (!article.keywords?.length) updateData.keywords = analysis.keywords;

					const contentCn = await this.translateContent(linked.content, ctx.env.OPENROUTER_API_KEY);
					if (contentCn) updateData.content_cn = contentCn;

					return { updateData };
				}
			} catch (e) {
				console.warn(`[TWITTER-PROCESSOR] Failed to scrape linked URL: ${linkedUrl}`, e);
			}
		}

		// 4. Regular tweet — translate tweet text
		const analysis = await translateTweet(tweetText, ctx.env.OPENROUTER_API_KEY);

		if (isEmpty(article.summary_cn)) updateData.summary_cn = analysis.summary_cn;
		if (!article.tags?.length) updateData.tags = analysis.tags;
		if (!article.keywords?.length) updateData.keywords = analysis.keywords;

		return { updateData };
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

	private async translateContent(content: string, apiKey: string): Promise<string | null> {
		const prompt = `請將以下文章內容翻譯成繁體中文。保持 Markdown 格式，包括標題、段落、列表等。只翻譯，不要添加任何額外內容。

${content}`;

		return callOpenRouter(prompt, { apiKey, model: AI_MODELS.FLASH, maxTokens: 8000 });
	}
}

// ─────────────────────────────────────────────────────────────
// HackerNews Processor
// ─────────────────────────────────────────────────────────────

interface HnComment {
	author?: string;
	text?: string;
	children?: HnComment[];
}

interface HnItemData {
	id: number;
	title?: string;
	url?: string;
	text?: string;
	author?: string;
	points?: number;
	descendants?: number;
	type?: string;
	children?: HnComment[];
}

function collectAllComments(children: HnComment[]): string[] {
	const comments: string[] = [];
	for (const child of children) {
		if (child.text) {
			const cleanText = child.text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
			if (cleanText) comments.push(cleanText);
		}
		if (child.children?.length) {
			comments.push(...collectAllComments(child.children));
		}
	}
	return comments;
}

async function summarizeDiscussion(apiKey: string, title: string, comments: string[]): Promise<string | null> {
	if (comments.length === 0) return null;

	const allText = comments.join('\n---\n').slice(0, 25000);
	const systemPrompt = 'You summarize Hacker News discussions. Extract key insights, main arguments, and interesting perspectives. Be concise (150-200 words). Use bullet points. Write in English.';
	const userPrompt = `Summarize the discussion about: "${title}"\n\nComments:\n${allText}`;

	return callOpenRouterChat(apiKey, systemPrompt, userPrompt, 400);
}

function extractItemId(article: Article): string | null {
	const metadata = article.platform_metadata as { data?: { itemId?: string } } | undefined;
	return metadata?.data?.itemId || null;
}

class HackerNewsProcessor implements ArticleProcessor {
	readonly sourceType = 'hackernews';

	async process(article: Article, ctx: ProcessorContext): Promise<ProcessorResult> {
		const itemId = extractItemId(article);
		const enrichments: Record<string, unknown> = {};

		// 1. 從 HN API 取得完整資料（包含評論）
		let hnData: HnItemData | null = null;
		if (itemId) {
			try {
				const response = await fetch(`${HN_ALGOLIA_API}/${itemId}`);
				if (response.ok) {
					hnData = (await response.json()) as HnItemData;
				}
			} catch (error) {
				console.error('[HN-PROCESSOR] Failed to fetch HN data:', error);
			}
		}

		// 2. 收集評論並用 AI 整理
		if (hnData?.children?.length) {
			const comments = collectAllComments(hnData.children);
			console.log(`[HN-PROCESSOR] Collected ${comments.length} comments for ${article.title.slice(0, 50)}...`);

			if (comments.length > 0) {
				const summary = await summarizeDiscussion(ctx.env.OPENROUTER_API_KEY, article.title, comments);
				if (summary) {
					enrichments.discussionSummary = summary;
					console.log(`[HN-PROCESSOR] Generated discussion summary (${summary.length} chars)`);
				}
			}
		}

		// 3. 存儲額外的 HN 資訊
		if (hnData) {
			enrichments.hnUrl = `https://news.ycombinator.com/item?id=${hnData.id}`;
			enrichments.externalUrl = hnData.url || null;
			enrichments.hnText = hnData.text || null;
		}

		// 4. 呼叫通用 AI 分析
		const analysis = await callGeminiForAnalysis(article, ctx.env.OPENROUTER_API_KEY);
		const updateData: ProcessorResult['updateData'] = {};

		const allTags = [...new Set([...analysis.tags, analysis.category, 'HackerNews'])];

		if (!article.tags?.length) updateData.tags = allTags;
		if (!article.keywords?.length) updateData.keywords = analysis.keywords;
		if (isEmpty(article.title_cn)) updateData.title_cn = analysis.title_cn;
		if (isEmpty(article.summary)) updateData.summary = analysis.summary_en;
		if (isEmpty(article.summary_cn)) updateData.summary_cn = analysis.summary_cn;

		return { updateData, enrichments };
	}
}

// ─────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────

const processors: Record<string, ArticleProcessor> = {
	hackernews: new HackerNewsProcessor(),
	twitter: new TwitterProcessor(),
	default: new DefaultProcessor(),
};

export function getProcessor(sourceType: string | undefined): ArticleProcessor {
	return processors[sourceType ?? 'default'] ?? processors.default;
}
