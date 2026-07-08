// ─────────────────────────────────────────────────────────────
// AI Utility Functions & Shared Processor Types
// ─────────────────────────────────────────────────────────────

import { generateObject, generateText } from '@core-ai/embedding';
import type { ArticleCategory, PlatformEnrichments } from '@core-shared/platform-metadata';
import { type AIAnalysisResult, type Article, ENTITY_TYPES } from '@core-shared/types';
import { entityExtractionExclusionNames } from '@entities/normalize';
import { z } from 'zod';
import type { ArticleStoreTable } from './article-store';

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
		og_image_url?: string;
		entities?: Array<{ name: string; name_cn: string; type: string }>;
	};
	enrichments?: PlatformEnrichments;
	classificationCategory?: ArticleCategory;
}

export interface ProcessorContext {
	env: Env;
	table: ArticleStoreTable;
}

export interface ArticleProcessor {
	process(article: Article, ctx: ProcessorContext): Promise<ProcessorResult>;
}

// ─────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────

export function isEmpty(value: string | null | undefined): boolean {
	return !value?.trim();
}

export type ArticleAnalysisMergeOptions = {
	updateData?: ProcessorResult['updateData'];
	extraTags?: string[];
	overwriteSummary?: boolean;
	includeContent?: boolean;
};

export function mergeArticleAnalysis(
	article: Article,
	analysis: AIAnalysisResult,
	options: ArticleAnalysisMergeOptions = {},
): { updateData: ProcessorResult['updateData']; classificationCategory?: ArticleCategory } {
	const updateData = options.updateData ?? {};
	const allTags = [...new Set([...(analysis.tags ?? []), ...(analysis.category ? [analysis.category] : []), ...(options.extraTags ?? [])])];
	const includeContent = options.includeContent ?? true;

	if (!article.tags?.length && allTags.length) updateData.tags = allTags;
	if (!article.keywords?.length && analysis.keywords?.length) updateData.keywords = analysis.keywords;
	if (isEmpty(article.title_cn) && analysis.title_cn) updateData.title_cn = analysis.title_cn;
	if ((options.overwriteSummary || isEmpty(article.summary)) && analysis.summary_en) updateData.summary = analysis.summary_en;
	if ((options.overwriteSummary || isEmpty(article.summary_cn)) && analysis.summary_cn) updateData.summary_cn = analysis.summary_cn;
	if (includeContent && analysis.content) updateData.content = analysis.content;
	if (includeContent && isEmpty(article.content_cn) && analysis.content_cn) updateData.content_cn = analysis.content_cn;
	if (analysis.entities) updateData.entities = analysis.entities;

	return { updateData, classificationCategory: analysis.category };
}

// ─────────────────────────────────────────────────────────────
// AI Analysis Functions
// ─────────────────────────────────────────────────────────────

const MAX_CONTENT_LENGTH = 10000;
const MAX_CONTENT_CLEANUP_LENGTH = 12000;
const MIN_CONTENT_CLEANUP_LENGTH = 800;
const MAX_CONTENT_TRANSLATION_LENGTH = 12000;
const MIN_CONTENT_TRANSLATION_LENGTH = 120;
const ARTICLE_CATEGORIES = ['AI', 'Tech', 'Finance', 'Research', 'Business', 'Other'] as const;

const ExtractedEntitySchema = z.object({
	name: z.string().min(1),
	name_cn: z.string().min(1),
	type: z.enum(ENTITY_TYPES),
});

const ArticleTranslationSchema = z.object({
	title_cn: z.string().min(1),
	summary_en: z.string().min(1),
	summary_cn: z.string().min(1),
});

const ArticleClassificationSchema = z.object({
	tags: z.array(z.string().min(1)).min(1),
	keywords: z.array(z.string().min(1)).min(1),
	entities: z.array(ExtractedEntitySchema),
	category: z.enum(ARTICLE_CATEGORIES),
});

const ARTICLE_TRANSLATION_SYSTEM_PROMPT = `你是專業的新聞翻譯和摘要編輯。請只輸出符合 schema 的翻譯與摘要。

任務：
- 翻譯 title_cn
- 產生 summary_en / summary_cn

翻譯要求：
- title_cn: 將標題翻譯成自然流暢的繁體中文
- summary_en: 用英文寫 1-2 句簡潔摘要
- summary_cn: 用繁體中文寫 1-2 句摘要；若原文是第一人稱或直接語氣，保持原文語氣，不要改寫成第三人稱描述
- 如果原文已是目標語言，保留自然表達，不要硬改寫
- 所有文字都不要使用 Markdown。`;

const ARTICLE_CONTENT_TRANSLATION_SYSTEM_PROMPT = `你是專業的新聞全文翻譯編輯。請將原文完整翻譯成自然流暢的繁體中文。

規則：
- 忠實翻譯原文，不要摘要、不要評論、不要新增資訊
- 保留 Markdown 結構、標題層級、列表、引用、連結和程式碼區塊
- 專有名詞保留常見英文名稱；必要時可在中文後保留英文
- 若原文已是繁體中文，直接保留原文
- 直接輸出翻譯後的 Markdown，不要包 code block。`;

const ARTICLE_CONTENT_CLEANUP_SYSTEM_PROMPT = `你是專業的新聞內容清理編輯。請清理抽取出的原文 Markdown，只移除非正文內容。

移除：
- 廣告、贊助、活動宣傳、newsletter/subscribe CTA、cookie/privacy banner
- 導航、頁尾、作者 bio、社群分享提示、推薦閱讀、熱門文章、相關文章列表
- 重複標題、重複段落、圖片版權雜訊、無關的 UI 文案

保留：
- 原文語言，不要翻譯
- 正文內容、必要的小標、列表、引用、連結、程式碼區塊
- 與文章主題直接相關的圖片 markdown

規則：
- 不要摘要、不要改寫、不要新增資訊
- 若內容已乾淨，直接原樣輸出
- 直接輸出清理後 Markdown，不要包 code block，不要解釋。`;

const ARTICLE_CLASSIFICATION_SYSTEM_PROMPT = `你是專業的新聞分類和實體分析師。請只輸出符合 schema 的分類資料。

任務：
- 產生 tags、keywords、category
- 擷取重要 named entities

標籤規則：
- AI相關: AI, MachineLearning, DeepLearning, NLP, ComputerVision, LLM, GenerativeAI
- 產品相關: Coding, VR, AR, Robotics, Automation, SoftwareDevelopment, API
- 產業應用: Tech, Finance, Healthcare, Education, Gaming, Enterprise, Creative
- 事件類型: Funding, IPO, Acquisition, ProductLaunch, Research, Partnership
- 新聞性質: Review, Opinion, Analysis, Feature, Interview, Tutorial, Announcement

實體擷取規則：
- 提取 3-8 個最重要的具名實體；如果文章太短，可以少於 3 個
- type 只能是 person, organization, product, technology, event, location
- name 用英文或原文慣用名稱；name_cn 用繁體中文，若無慣用中文名則與 name 相同
- 不要把文章來源、平台、作者名稱當作實體，除非文章主題就是該來源、平台或作者本身
- 不要提取泛詞、短縮碎片、股票代號或單字母縮寫，例如 AI、X、Go、US、C、RL、PI、$GOOGL
- 模型、產品、活動請使用完整慣用名稱，例如 Claude Opus 4.7、DeepSeek V4、TechCrunch Disrupt 2026
- 如果只能判斷出泛詞、版本碎片或來源名稱，寧可少提取

分類只能是：AI, Tech, Finance, Research, Business, Other。`;

function buildArticleContextPrompt(article: Article): string {
	const content = article.content || article.summary || article.title;
	const excludedEntities = entityExtractionExclusionNames(article.source, article.platform_metadata);
	const excludedLine = excludedEntities.length ? `\n實體排除名單: ${excludedEntities.join(', ')}` : '';
	return `文章資訊:
標題: ${article.title}
來源: ${article.source}
來源類型: ${article.source_type ?? 'unknown'}${excludedLine}
摘要: ${article.summary || article.summary_cn || '無摘要'}
內容:
${content.substring(0, MAX_CONTENT_LENGTH)}`;
}

function cjkRatio(text: string): number {
	const letters = text.match(/[A-Za-z\u3400-\u9FFF]/g)?.length ?? 0;
	if (!letters) return 0;
	const cjk = text.match(/[\u3400-\u9FFF]/g)?.length ?? 0;
	return cjk / letters;
}

function shouldTranslateArticleContent(article: Article): boolean {
	const content = article.content?.trim();
	if (!content || content.length < MIN_CONTENT_TRANSLATION_LENGTH) return false;
	if (!isEmpty(article.content_cn)) return false;
	return cjkRatio(content) < 0.6;
}

function normalizeComparableContent(content: string): string {
	return content.replace(/\s+/g, ' ').trim();
}

function looksLikeModelExplanation(content: string): boolean {
	return /^(以下是|這是|Here is|I've cleaned|I cleaned|清理後|已清理)/i.test(content.trim());
}

function validateCleanedContent(original: string, cleaned: string | null): string | null {
	const trimmed = cleaned?.trim();
	if (!trimmed || looksLikeModelExplanation(trimmed)) return null;
	const originalComparable = normalizeComparableContent(original);
	const cleanedComparable = normalizeComparableContent(trimmed);
	if (!cleanedComparable || cleanedComparable === originalComparable) return null;
	if (cleanedComparable.length < Math.max(300, originalComparable.length * 0.25)) return null;
	if (cleanedComparable.length > originalComparable.length * 1.15) return null;
	return trimmed;
}

async function generateArticleContentCleanup(article: Article, env: Env): Promise<string | null> {
	const content = article.content?.trim();
	if (!content || content.length < MIN_CONTENT_CLEANUP_LENGTH || article.source_type === 'youtube' || article.source_type === 'hackernews')
		return null;
	const cleanupContent = content.slice(0, MAX_CONTENT_CLEANUP_LENGTH);
	const cleaned = await generateText(env.AI, `原文 Markdown:\n${cleanupContent}`, {
		task: 'article-content-cleanup',
		gatewayId: env.AI_GATEWAY_NAME,
		maxTokens: 6000,
		temperature: 0.1,
		systemPrompt: ARTICLE_CONTENT_CLEANUP_SYSTEM_PROMPT,
	});
	return validateCleanedContent(cleanupContent, cleaned);
}

export async function generateArticleAnalysis(article: Article, env: Env): Promise<AIAnalysisResult> {
	console.info({ tag: 'AI', msg: 'Analyzing', title: article.title.substring(0, 80) });

	try {
		const cleanedContent = await generateArticleContentCleanup(article, env).catch((error) => {
			console.error({ tag: 'AI', msg: 'Article content cleanup failed', error: String(error) });
			return null;
		});
		const articleForAnalysis = cleanedContent ? { ...article, content: cleanedContent } : article;
		const articlePrompt = buildArticleContextPrompt(articleForAnalysis);
		const contentForTranslation = shouldTranslateArticleContent(articleForAnalysis)
			? articleForAnalysis.content!.trim().slice(0, MAX_CONTENT_TRANSLATION_LENGTH)
			: null;
		const [translation, classification, contentTranslation] = await Promise.all([
			generateObject(env.AI, articlePrompt, {
				schema: ArticleTranslationSchema,
				task: 'article-translation',
				gatewayId: env.AI_GATEWAY_NAME,
				maxTokens: 700,
				systemPrompt: ARTICLE_TRANSLATION_SYSTEM_PROMPT,
			}).catch((error) => {
				console.error({ tag: 'AI', msg: 'Article translation failed', error: String(error) });
				return null;
			}),
			generateObject(env.AI, articlePrompt, {
				schema: ArticleClassificationSchema,
				task: 'article-classification',
				gatewayId: env.AI_GATEWAY_NAME,
				maxTokens: 500,
				systemPrompt: ARTICLE_CLASSIFICATION_SYSTEM_PROMPT,
			}).catch((error) => {
				console.error({ tag: 'AI', msg: 'Article classification failed', error: String(error) });
				return null;
			}),
			contentForTranslation
				? generateText(env.AI, `原文 Markdown:\n${contentForTranslation}`, {
						task: 'article-content-translation',
						gatewayId: env.AI_GATEWAY_NAME,
						maxTokens: 6000,
						temperature: 0.2,
						systemPrompt: ARTICLE_CONTENT_TRANSLATION_SYSTEM_PROMPT,
					}).catch((error) => {
						console.error({ tag: 'AI', msg: 'Article content translation failed', error: String(error) });
						return null;
					})
				: Promise.resolve(null),
		]);

		const analysis: AIAnalysisResult = {};
		if (cleanedContent) {
			analysis.content = cleanedContent;
		}
		if (translation) {
			analysis.summary_en = translation.summary_en;
			analysis.summary_cn = translation.summary_cn;
			analysis.title_cn = translation.title_cn;
		}
		if (contentTranslation?.trim()) {
			analysis.content_cn = contentTranslation.trim();
		}
		if (classification) {
			analysis.tags = classification.tags.slice(0, 5);
			analysis.keywords = classification.keywords.slice(0, 8);
			analysis.category = classification.category;
			analysis.entities = classification.entities.slice(0, 10);
		}
		return analysis;
	} catch (error) {
		console.error({ tag: 'AI', msg: 'Parse failed', error: String(error) });
		return {};
	}
}
