// ─────────────────────────────────────────────────────────────
// AI Utility Functions & Shared Processor Types
// ─────────────────────────────────────────────────────────────

import type { Client } from 'pg';
import { logError, logInfo } from '../infra/log';
import { AI_MODELS, callOpenRouter, extractJson } from '../infra/openrouter';
import type { PlatformEnrichments } from '../models/platform-metadata';
import type { AIAnalysisResult, Article, Env } from '../models/types';

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
		og_image_url?: string;
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
// AI Analysis Functions (business logic using OpenRouter)
// ─────────────────────────────────────────────────────────────

const MAX_CONTENT_LENGTH = 10000;

export function createFallbackResult(article: Article): AIAnalysisResult {
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
