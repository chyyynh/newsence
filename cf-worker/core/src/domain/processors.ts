import type { Client } from 'pg';
import { prepareArticleTextForEmbedding } from '../infra/embedding';
import { logError, logInfo, logWarn } from '../infra/log';
import { AI_MODELS, callOpenRouter, extractJson } from '../infra/openrouter';
import type { PlatformEnrichments, PlatformMetadata } from '../models/platform-metadata';
import type { AIAnalysisResult, Article, Env } from '../models/types';
import { HN_ALGOLIA_API, scrapeWebPage } from './scrapers';

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
	enrichments?: PlatformEnrichments;
}

export interface ProcessorContext {
	env: Env;
	db: Client;
	table: string;
}

export interface ProcessingDeps {
	env: Env;
	db: Client;
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

export async function callOpenRouterChat(apiKey: string, systemPrompt: string, userPrompt: string): Promise<string | null> {
	return callOpenRouter(userPrompt, {
		apiKey,
		model: AI_MODELS.FLASH,
		systemPrompt,
	});
}

export async function translateContent(content: string, apiKey: string): Promise<string | null> {
	const prompt = `請將以下文章內容翻譯成繁體中文。保持 Markdown 格式，包括標題、段落、列表等。只翻譯，不要添加任何額外內容。

${content}`;

	return callOpenRouter(prompt, { apiKey, model: AI_MODELS.FLASH, timeoutMs: 180_000 });
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
		const hasFullContent = !isEmpty(article.content) && article.content!.length > 200;

		// 1. Twitter Article — content is already full text from scrapeTwitterArticle
		if (hasFullContent) {
			logInfo('TWITTER-PROCESSOR', 'Processing Twitter Article', { title: article.title.slice(0, 50) });
			const analysis = await callGeminiForAnalysis(article, ctx.env.OPENROUTER_API_KEY);

			if (isEmpty(article.title_cn)) updateData.title_cn = analysis.title_cn;
			if (isEmpty(article.summary)) updateData.summary = analysis.summary_en;
			if (isEmpty(article.summary_cn)) updateData.summary_cn = analysis.summary_cn;
			if (!article.tags?.length) updateData.tags = [...new Set([...analysis.tags, analysis.category])];
			if (!article.keywords?.length) updateData.keywords = analysis.keywords;

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
					logInfo('TWITTER-PROCESSOR', 'Scraped linked article', { title: linked.title });
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

					return { updateData };
				}
			} catch (e) {
				logWarn('TWITTER-PROCESSOR', 'Failed to scrape linked URL', { url: linkedUrl, error: String(e) });
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
}

// ─────────────────────────────────────────────────────────────
// HackerNews Processor
// ─────────────────────────────────────────────────────────────

interface HnComment {
	id?: number;
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

interface HnCollectedComment {
	id?: number;
	author?: string;
	text: string;
}

function cleanHtmlText(raw: string): string {
	return raw
		.replace(/<[^>]*>/g, ' ')
		.replace(/&quot;/g, '"')
		.replace(/&#x27;|&#39;/g, "'")
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/\s+/g, ' ')
		.trim();
}

export function collectAllComments(children: HnComment[]): HnCollectedComment[] {
	const comments: HnCollectedComment[] = [];
	for (const child of children) {
		if (child.text) {
			const cleanText = cleanHtmlText(child.text);
			if (cleanText) {
				comments.push({
					id: child.id,
					author: child.author,
					text: cleanText,
				});
			}
		}
		if (child.children?.length) {
			comments.push(...collectAllComments(child.children));
		}
	}
	return comments;
}

function extractPostLinks(externalUrl?: string | null, hnTextHtml?: string | null): string[] {
	const seen = new Set<string>();
	const urls: string[] = [];
	if (externalUrl) {
		seen.add(externalUrl);
		urls.push(externalUrl);
	}
	if (hnTextHtml) {
		const hrefMatches = hnTextHtml.match(/href="([^"]+)"/g);
		for (const m of hrefMatches ?? []) {
			const raw = m
				.slice(6, -1)
				.replace(/&#x2F;/g, '/')
				.replace(/&amp;/g, '&');
			if (!seen.has(raw) && raw.startsWith('http')) {
				seen.add(raw);
				urls.push(raw);
			}
		}
	}
	return urls;
}

interface EditorialPrompts {
	system: string;
	instruction: string;
	rules: string[];
}

const EDITORIAL_CN: EditorialPrompts = {
	system: '你是一位專業的科技新聞編輯，負責將 Hacker News 討論串整理成深度筆記。只使用提供的素材，直接輸出繁體中文 Markdown。',
	instruction: `請用繁體中文撰寫 500-800 字的整理筆記，用段落式敘述，不要用條列式重點。格式：

## 背景
2-3 句介紹文章脈絡，讓沒看過原文的人快速了解在討論什麼。

## 社群觀點
最重要的部分。用連貫的段落整理 HN 留言者的觀點，包括主要的支持與反對意見、有趣的補充觀點、值得注意的爭論或共識。像寫一篇短評一樣自然地串接不同觀點。

## 延伸閱讀
留言中提到的有價值的資源、工具、連結。沒有就省略此段。`,
	rules: [
		'繁體中文，嚴禁簡體',
		'不要使用任何 emoji',
		'重點是社群怎麼看，不是複述原文',
		'引用留言觀點做歸納，不逐字翻譯',
		'語氣中立客觀但不死板',
		'直接輸出 Markdown，不要包在 code block 裡',
	],
};

const EDITORIAL_EN: EditorialPrompts = {
	system:
		'You are a professional tech news editor. Summarize Hacker News discussions into in-depth editorial notes. Use only the provided material. Output Markdown directly.',
	instruction: `Write a 400-600 word editorial note in English using flowing paragraphs, not bullet points. Format:

## Background
2-3 sentences of context so a reader unfamiliar with the article can quickly understand what is being discussed.

## Community Perspectives
The most important section. Summarize HN commenters' viewpoints in coherent paragraphs — major arguments for and against, interesting supplementary perspectives, and notable debates or consensus. Weave different viewpoints together naturally, like a short commentary piece.

## Further Reading
Valuable resources, tools, or links mentioned in the comments. Omit this section if none.`,
	rules: [
		'Write in English',
		'Do not use any emoji',
		'Focus on how the community reacted, not restating the article',
		'Synthesize and paraphrase commenter opinions — do not translate verbatim',
		'Maintain a neutral, objective but engaging tone',
		'Output Markdown directly, do not wrap in a code block',
	],
};

function buildEditorialPrompt(
	prompts: EditorialPrompts,
	title: string,
	hnText: string,
	commentInput: string,
	commentCount: number,
	pageExcerpt: string,
): { system: string; user: string } {
	const rulesBlock = prompts.rules.map((r) => `- ${r}`).join('\n');
	const user = `Title: ${title}
Article excerpt (${pageExcerpt.length} chars):
${pageExcerpt || 'N/A'}

HN post text:
${cleanHtmlText(hnText).slice(0, 1200) || 'N/A'}

HN comments (${commentCount} total):
${commentInput}

${prompts.instruction}

Rules:
${rulesBlock}`;
	return { system: prompts.system, user };
}

async function generateHnEditorial(
	apiKey: string,
	title: string,
	hnText: string,
	comments: HnCollectedComment[],
	externalPageContent?: string | null,
): Promise<{ en: string | null; cn: string | null }> {
	if (comments.length < 4 && !(externalPageContent && externalPageContent.length >= 600)) {
		return { en: null, cn: null };
	}

	const commentInput = comments
		.map((c) => `${c.author ? `${c.author}: ` : ''}${c.text}`)
		.join('\n')
		.slice(0, 30000);
	const pageExcerpt = externalPageContent?.slice(0, 6000) ?? '';

	const cnPrompt = buildEditorialPrompt(EDITORIAL_CN, title, hnText, commentInput, comments.length, pageExcerpt);
	const enPrompt = buildEditorialPrompt(EDITORIAL_EN, title, hnText, commentInput, comments.length, pageExcerpt);

	const [cn, en] = await Promise.all([
		callOpenRouterChat(apiKey, cnPrompt.system, cnPrompt.user),
		callOpenRouterChat(apiKey, enPrompt.system, enPrompt.user),
	]);

	return { en, cn };
}

function extractItemId(article: Article): string | null {
	const metadata = article.platform_metadata;
	if (metadata?.type === 'hackernews') return metadata.data.itemId || null;
	return null;
}

class HackerNewsProcessor implements ArticleProcessor {
	readonly sourceType = 'hackernews';

	async process(article: Article, ctx: ProcessorContext): Promise<ProcessorResult> {
		const itemId = extractItemId(article);
		const enrichments: PlatformEnrichments = {};
		const updateData: ProcessorResult['updateData'] = {};

		// 1. 從 HN API 取得完整資料（包含評論）
		const hnData = await this.fetchHnData(itemId);

		// 2. 收集評論與外部文章
		const comments = hnData?.children?.length ? collectAllComments(hnData.children) : [];
		if (comments.length > 0) {
			logInfo('HN-PROCESSOR', 'Collected comments', { count: comments.length, title: article.title.slice(0, 50) });
		}

		const { content: externalPageContent } = await this.fetchExternalPage(hnData?.url, ctx.env);

		// 3. generateHnEditorial — 平行產生 content (EN) + content_cn
		if (hnData) {
			const editorial = await generateHnEditorial(
				ctx.env.OPENROUTER_API_KEY,
				article.title,
				hnData.text || '',
				comments,
				externalPageContent,
			);
			if (editorial.cn) {
				updateData.content_cn = editorial.cn;
				logInfo('HN-PROCESSOR', 'Generated editorial content_cn', { chars: editorial.cn.length });
			}
			if (editorial.en) {
				updateData.content = editorial.en;
				logInfo('HN-PROCESSOR', 'Generated editorial content', { chars: editorial.en.length });
			}

			// Fallback: if editorial generation failed, use scraped page content directly
			if (!updateData.content && externalPageContent && externalPageContent.length > 100) {
				updateData.content = externalPageContent;
				logWarn('HN-PROCESSOR', 'Editorial failed, falling back to scraped content', { chars: externalPageContent.length });
			}

			enrichments.hnUrl = `https://news.ycombinator.com/item?id=${hnData.id}`;
			enrichments.externalUrl = hnData.url || null;
			enrichments.hnText = hnData.text || null;
			enrichments.commentCount = comments.length;
			enrichments.links = extractPostLinks(hnData.url, hnData.text);
		}

		// 4. callGeminiForAnalysis — 用外部文章（若有）做分析，品質更好
		const articleForAnalysis = externalPageContent ? { ...article, content: externalPageContent, summary: null } : article;
		const analysis = await callGeminiForAnalysis(articleForAnalysis, ctx.env.OPENROUTER_API_KEY);
		const allTags = [...new Set([...analysis.tags, analysis.category, 'HackerNews'])];

		if (!article.tags?.length) updateData.tags = allTags;
		if (!article.keywords?.length) updateData.keywords = analysis.keywords;
		if (isEmpty(article.title_cn)) updateData.title_cn = analysis.title_cn;
		updateData.summary = analysis.summary_en;
		updateData.summary_cn = analysis.summary_cn;

		return { updateData, enrichments };
	}

	private async fetchHnData(itemId: string | null): Promise<HnItemData | null> {
		if (!itemId) return null;
		try {
			const response = await fetch(`${HN_ALGOLIA_API}/${itemId}`);
			return response.ok ? ((await response.json()) as HnItemData) : null;
		} catch (error) {
			logError('HN-PROCESSOR', 'Failed to fetch HN data', { error: String(error) });
			return null;
		}
	}

	private async fetchExternalPage(url: string | undefined, env: Env): Promise<{ title: string | null; content: string | null }> {
		if (!url) return { title: null, content: null };
		try {
			const page = await scrapeWebPage(url);
			return { title: page.title || null, content: page.content || null };
		} catch (error) {
			logWarn('HN-PROCESSOR', 'Failed to scrape linked webpage', { error: String(error) });
			return { title: null, content: null };
		}
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

export function mergePlatformMetadata(
	baseMetadata: PlatformMetadata | null | undefined,
	enrichments?: PlatformEnrichments,
): PlatformMetadata | null {
	if (!baseMetadata && (!enrichments || Object.keys(enrichments).length === 0)) return baseMetadata ?? null;
	if (!enrichments || Object.keys(enrichments).length === 0) return baseMetadata ?? null;
	if (!baseMetadata) return null;

	return {
		...baseMetadata,
		enrichments: {
			...(baseMetadata.enrichments || {}),
			...enrichments,
			processedAt: new Date().toISOString(),
		},
	};
}

export async function runArticleProcessor(
	article: Article,
	sourceType: string | undefined,
	deps: ProcessingDeps,
): Promise<ProcessorResult> {
	const processor = getProcessor(sourceType);
	const ctx: ProcessorContext = {
		env: deps.env,
		db: deps.db,
		table: deps.table,
	};
	return processor.process(article, ctx);
}

export async function persistProcessorResult(
	articleId: string,
	article: Article,
	result: ProcessorResult,
	deps: ProcessingDeps,
): Promise<void> {
	const mergedMetadata = mergePlatformMetadata(article.platform_metadata, result.enrichments);
	const updatePayload: Record<string, unknown> = { ...result.updateData };
	if (mergedMetadata) updatePayload.platform_metadata = mergedMetadata;

	if (Object.keys(updatePayload).length === 0) return;

	const columns = Object.keys(updatePayload);
	const setClauses = columns.map((col, i) => `${col} = $${i + 1}`).join(', ');
	const values = columns.map((col) => {
		const val = updatePayload[col];
		// JSON columns (objects/arrays that aren't native pg arrays for tags/keywords)
		if (val !== null && typeof val === 'object' && col !== 'tags' && col !== 'keywords') {
			return JSON.stringify(val);
		}
		return val;
	});
	values.push(articleId);

	const sql = `UPDATE ${deps.table} SET ${setClauses} WHERE id = $${values.length}`;
	const queryResult = await deps.db.query(sql, values);
	if (queryResult.rowCount === 0) {
		throw new Error(`Failed to update article ${articleId}: no rows matched`);
	}
}

export function buildEmbeddingTextForArticle(
	article: Pick<Article, 'title' | 'title_cn' | 'summary' | 'summary_cn' | 'tags' | 'keywords'>,
	result: ProcessorResult,
): string {
	return prepareArticleTextForEmbedding({
		title: article.title,
		title_cn: result.updateData.title_cn ?? article.title_cn,
		summary: result.updateData.summary ?? article.summary,
		summary_cn: result.updateData.summary_cn ?? article.summary_cn,
		tags: result.updateData.tags ?? article.tags,
		keywords: result.updateData.keywords ?? article.keywords,
	});
}

// ─────────────────────────────────────────────────────────────
// AI Analysis Functions (business logic using OpenRouter)
// ─────────────────────────────────────────────────────────────

const MAX_CONTENT_LENGTH = 10000;

function createFallbackResult(article: Article): AIAnalysisResult {
	return {
		tags: ['Other'],
		keywords: article.title.split(' ').slice(0, 5),
		summary_en: article.summary ?? `${article.title.substring(0, 100)}...`,
		summary_cn: article.summary_cn ?? article.summary ?? `${article.title.substring(0, 100)}...`,
		title_en: article.title,
		title_cn: article.title_cn ?? article.title,
		category: 'Other',
	};
}

export async function callGeminiForAnalysis(article: Article, apiKey: string): Promise<AIAnalysisResult> {
	logInfo('AI', 'Analyzing', { title: article.title.substring(0, 80) });

	const content = article.content || article.summary || article.title;
	const prompt = `作為一個專業的新聞分析師和翻譯師,請分析以下新聞文章並提供結構化的分析結果,包含英文和中文版本。
文章資訊:
標題: ${article.title}
來源: ${article.source}
摘要: ${article.summary || article.summary_cn || '無摘要'}
內容: ${content.substring(0, MAX_CONTENT_LENGTH)}...

請以JSON格式回答,包含以下欄位:
{
"tags": ["標籤1", "標籤2", "標籤3"],
"keywords": ["關鍵字1", "關鍵字2", "關鍵字3", "關鍵字4", "關鍵字5"],
"title_en": "英文標題翻譯",
"title_cn": "繁體中文標題翻譯",
"summary_en": "English summary in 1-2 sentences",
"summary_cn": "用繁體中文寫1-2句話的新聞摘要",
"category": "新聞分類"
}

翻譯要求:
- title_en: 將標題翻譯成自然流暢的英文
- title_cn: 將標題翻譯成自然流暢的繁體中文
- summary_en: 用英文寫簡潔的摘要
- summary_cn: 用繁體中文直接翻譯摘要，保持原文語氣和人稱，不要改寫成第三人稱描述
- 所有翻譯結果不要使用 Markdown 格式（不要用 **粗體**、- 列表、# 標題等），純文字即可

標籤規則:
- AI相關: AI, MachineLearning, DeepLearning, NLP, ComputerVision, LLM, GenerativeAI
- 產品相關: Coding, VR, AR, Robotics, Automation, SoftwareDevelopment, API
- 產業應用: Tech, Finance, Healthcare, Education, Gaming, Enterprise, Creative
- 事件類型: Funding, IPO, Acquisition, ProductLaunch, Research, Partnership
- 新聞性質: Review, Opinion, Analysis, Feature, Interview, Tutorial, Announcement

分類選項: AI, Tech, Finance, Research, Business, Other

請只回傳JSON,不要其他文字。`;

	const rawContent = await callOpenRouter(prompt, { apiKey, maxTokens: 800 });
	if (!rawContent?.trim()) return createFallbackResult(article);

	logInfo('AI', 'Response', { content: rawContent });

	try {
		const result = extractJson<AIAnalysisResult>(rawContent);
		if (!result || !Array.isArray(result.tags) || !Array.isArray(result.keywords) || !result.summary_en || !result.summary_cn) {
			throw new Error('Invalid response format');
		}

		return {
			tags: result.tags.slice(0, 5),
			keywords: result.keywords.slice(0, 8),
			summary_en: result.summary_en,
			summary_cn: result.summary_cn,
			title_en: result.title_en,
			title_cn: result.title_cn,
			category: result.category ?? 'Other',
		};
	} catch (error) {
		logError('AI', 'Parse failed', { error: String(error) });
		return createFallbackResult(article);
	}
}

interface TweetAnalysis {
	summary_cn: string;
	tags: string[];
	keywords: string[];
}

const TWEET_FALLBACK: TweetAnalysis = { summary_cn: '', tags: ['Twitter'], keywords: [] };

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
  "keywords": ["關鍵字1", "關鍵字2", "關鍵字3"]
}

標籤規則：
- AI相關: AI, MachineLearning, DeepLearning, LLM, GenerativeAI
- 產品相關: Coding, Robotics, SoftwareDevelopment, API
- 產業應用: Tech, Finance, Healthcare, Gaming, Creative
- 事件類型: ProductLaunch, Research, Partnership, Announcement

請只回傳JSON，不要其他文字。`;

	const rawContent = await callOpenRouter(prompt, { apiKey, maxTokens: 500 });
	if (!rawContent) return { ...TWEET_FALLBACK, summary_cn: tweetText };

	try {
		const result = extractJson<TweetAnalysis>(rawContent);
		if (!result) throw new Error('No JSON found');

		return {
			summary_cn: result.summary_cn ?? tweetText,
			tags: (result.tags ?? ['Twitter']).slice(0, 5),
			keywords: (result.keywords ?? []).slice(0, 8),
		};
	} catch (error) {
		logError('AI', 'Tweet translation failed', { error: String(error) });
		return { ...TWEET_FALLBACK, summary_cn: tweetText };
	}
}

// ─────────────────────────────────────────────────────────────
// Content Assessment
// ─────────────────────────────────────────────────────────────

export interface ContentInput {
	title?: string;
	text: string;
	url: string;
	source: string;
	sourceType: 'twitter' | 'rss' | 'hackernews';
	links?: string[];
	metrics?: { viewCount?: number; likeCount?: number };
}

export interface ContentAssessment {
	action: 'save' | 'follow_link' | 'discard';
	score: number;
	reason: string;
	contentType: 'original_content' | 'link_share' | 'discussion' | 'announcement';
}

const CONTENT_ASSESSMENT_PROMPT = `你是內容品質評估專家。判斷這則內容應該如何處理。

【內容資訊】
來源: {source}
類型: {sourceType}
標題: {title}
文字長度: {textLength} 字
文字內容: {text}
包含連結: {links}
互動數據: viewCount={viewCount}, likeCount={likeCount}

【判斷標準】

1. save (直接儲存) - 分數 >= 60
   - 有實質內容 (>100字有意義的文字)
   - 原創分析、技術討論、官方公告
   - 包含具體數據、研究結果、技術細節

2. follow_link (抓取連結內容) - 分數 40-59
   - 文字很短但分享了可能有價值的連結
   - 例如: "這篇很棒: [連結]"、"重要更新: [連結]"
   - 連結不是社群媒體 (twitter/instagram/tiktok)

3. discard (丟棄) - 分數 < 40
   - 純宣傳無實質內容 ("試試 X！")
   - 語意不明、低品質
   - 連結是其他社群媒體
   - 重複/垃圾內容

【評分維度】
- 內容完整性 (0-40): 有實質內容得高分
- 信息價值 (0-35): 有具體數據/分析得高分
- 來源可信度 (0-25): 官方/知名來源得高分

【回傳 JSON】
{
  "action": "save" | "follow_link" | "discard",
  "score": 0-100,
  "reason": "簡短說明 (20字內)",
  "contentType": "original_content" | "link_share" | "discussion" | "announcement"
}

只回傳 JSON，不要其他文字。`;

const DEFAULT_ASSESSMENT: ContentAssessment = {
	action: 'save',
	score: 50,
	reason: 'AI evaluation failed, default save',
	contentType: 'original_content',
};

export async function assessContent(input: ContentInput, apiKey: string): Promise<ContentAssessment> {
	logInfo('AI', 'Assessing', { title: input.title?.substring(0, 50) ?? input.text.substring(0, 50) });

	const prompt = CONTENT_ASSESSMENT_PROMPT.replace('{source}', input.source)
		.replace('{sourceType}', input.sourceType)
		.replace('{title}', input.title ?? 'N/A')
		.replace('{textLength}', String(input.text.length))
		.replace('{text}', input.text.substring(0, 1000))
		.replace('{links}', input.links?.join(', ') ?? 'None')
		.replace('{viewCount}', String(input.metrics?.viewCount ?? 'N/A'))
		.replace('{likeCount}', String(input.metrics?.likeCount ?? 'N/A'));

	const rawContent = await callOpenRouter(prompt, { apiKey, maxTokens: 200, temperature: 0.1 });
	if (!rawContent) return DEFAULT_ASSESSMENT;

	try {
		const result = extractJson<ContentAssessment>(rawContent);
		if (!result || !result.action || typeof result.score !== 'number') {
			throw new Error('Invalid assessment format');
		}

		logInfo('AI', 'Assessment result', { action: result.action, score: result.score, reason: result.reason });
		return {
			action: result.action,
			score: result.score,
			reason: result.reason ?? '',
			contentType: result.contentType ?? 'original_content',
		};
	} catch (error) {
		logError('AI', 'Assessment parse failed', { error: String(error) });
		return DEFAULT_ASSESSMENT;
	}
}

// ─────────────────────────────────────────────────────────────
// YouTube Highlights
// ─────────────────────────────────────────────────────────────

interface YouTubeHighlight {
	title: string;
	summary: string;
	startTime: number;
	endTime: number;
}

export interface YouTubeHighlightsResult {
	highlights: YouTubeHighlight[];
}

interface TranscriptSegment {
	startTime: number;
	endTime: number;
	text: string;
}

const HIGHLIGHTS_SYSTEM_PROMPT = `你是專業的影片內容分析師。分析 YouTube 影片逐字稿，找出 5-8 個最重要的主題段落。

規則：
1. 每個段落代表一個獨立主題
2. 段落之間不重疊
3. 標題要精簡有力（30字內）
4. 時間戳記要準確對應討論內容的起止
5. 所有文字使用繁體中文

回傳 JSON 格式：
{
  "highlights": [
    { "title": "段落標題", "summary": "1-2句摘要", "startTime": 0, "endTime": 60 }
  ]
}

只回傳 JSON，不要其他文字。`;

export async function generateYouTubeHighlights(
	videoId: string,
	transcript: TranscriptSegment[],
	apiKey: string,
): Promise<YouTubeHighlightsResult | null> {
	logInfo('AI', 'Generating YouTube highlights', { videoId });

	const transcriptText = transcript.map((s) => `[${Math.floor(s.startTime)}s] ${s.text}`).join('\n');
	const last = transcript[transcript.length - 1];
	const duration = Math.ceil(last.endTime);

	const rawContent = await callOpenRouter(`影片總長度：${duration} 秒\n\n逐字稿：\n${transcriptText}`, {
		apiKey,
		model: AI_MODELS.FLASH,
		maxTokens: 2000,
		temperature: 0.3,
		systemPrompt: HIGHLIGHTS_SYSTEM_PROMPT,
	});

	if (!rawContent) {
		logError('AI', 'YouTube highlights: empty response', { videoId });
		return null;
	}

	const result = extractJson<YouTubeHighlightsResult>(rawContent);
	if (!result?.highlights || !Array.isArray(result.highlights) || result.highlights.length === 0) {
		logError('AI', 'YouTube highlights: invalid JSON', { videoId });
		return null;
	}

	logInfo('AI', 'YouTube highlights generated', { videoId, count: result.highlights.length });
	return result;
}
