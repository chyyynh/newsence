// ─────────────────────────────────────────────────────────────
// AI Utility Functions & Shared Processor Types
// ─────────────────────────────────────────────────────────────

import { AI_TASKS, generateObject } from '@shared/ai';
import type { ProcessableTable } from '@shared/db';
import type { PlatformEnrichments } from '@shared/platform-metadata';
import type { AIAnalysisResult, Article, Env } from '@shared/types';
import { z } from 'zod';

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
	/**
	 * Measured OG image dimensions, merged into `platform_metadata` at persist
	 * time (creating a `default` envelope if none exists). Populated by the
	 * workflow's measure step for articles that have an og image but no
	 * source-provided `og:image:width/height` meta tags.
	 */
	ogImageDimensions?: { width: number; height: number };
}

export interface ProcessorContext {
	env: Env;
	table: ProcessableTable;
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

// ─────────────────────────────────────────────────────────────
// AI Analysis Functions
// ─────────────────────────────────────────────────────────────

const MAX_CONTENT_LENGTH = 10000;
const ENTITY_TYPES = ['person', 'organization', 'product', 'technology', 'event'] as const;
const ARTICLE_CATEGORIES = ['AI', 'Tech', 'Finance', 'Research', 'Business', 'Other'] as const;

const ExtractedEntitySchema = z.object({
	name: z.string().min(1),
	name_cn: z.string().min(1),
	type: z.enum(ENTITY_TYPES),
});

const ArticleAnalysisSchema = z.object({
	tags: z.array(z.string().min(1)).min(1),
	keywords: z.array(z.string().min(1)).min(1),
	entities: z.array(ExtractedEntitySchema),
	title_en: z.string().min(1),
	title_cn: z.string().min(1),
	summary_en: z.string().min(1),
	summary_cn: z.string().min(1),
	category: z.enum(ARTICLE_CATEGORIES),
});

type ArticleAnalysisObject = z.infer<typeof ArticleAnalysisSchema>;

const ARTICLE_ANALYSIS_SYSTEM_PROMPT = `你是專業的新聞分析師和翻譯師。請輸出符合 schema 的結構化分析。

任務：
- 產生 tags、keywords、category
- 翻譯 title_en / title_cn
- 產生 summary_en / summary_cn
- 擷取重要 named entities

翻譯要求：
- title_en: 將標題翻譯成自然流暢的英文
- title_cn: 將標題翻譯成自然流暢的繁體中文
- summary_en: 用英文寫 1-2 句簡潔摘要
- summary_cn: 用繁體中文寫 1-2 句摘要；若原文是第一人稱或直接語氣，保持原文語氣，不要改寫成第三人稱描述
- 所有文字都不要使用 Markdown

標籤規則：
- AI相關: AI, MachineLearning, DeepLearning, NLP, ComputerVision, LLM, GenerativeAI
- 產品相關: Coding, VR, AR, Robotics, Automation, SoftwareDevelopment, API
- 產業應用: Tech, Finance, Healthcare, Education, Gaming, Enterprise, Creative
- 事件類型: Funding, IPO, Acquisition, ProductLaunch, Research, Partnership
- 新聞性質: Review, Opinion, Analysis, Feature, Interview, Tutorial, Announcement

實體擷取規則：
- 提取 3-8 個最重要的具名實體；如果文章太短，可以少於 3 個
- type 只能是 person, organization, product, technology, event
- name 用英文或原文慣用名稱；name_cn 用繁體中文，若無慣用中文名則與 name 相同

分類只能是：AI, Tech, Finance, Research, Business, Other。`;

function buildArticleAnalysisPrompt(article: Article): string {
	const content = article.content || article.summary || article.title;
	return `文章資訊:
標題: ${article.title}
來源: ${article.source}
摘要: ${article.summary || article.summary_cn || '無摘要'}
內容:
${content.substring(0, MAX_CONTENT_LENGTH)}`;
}

function createFallbackResult(article: Article): AIAnalysisResult {
	return {
		tags: ['Other'],
		keywords: article.title.split(' ').slice(0, 5),
		summary_en: article.summary ?? `${article.title.substring(0, 100)}...`,
		summary_cn: article.summary_cn ?? article.summary ?? `${article.title.substring(0, 100)}...`,
		title_en: article.title,
		title_cn: article.title_cn ?? article.title,
		category: 'Other',
		entities: [],
	};
}

export async function generateArticleAnalysis(article: Article, ai: Env['AI']): Promise<AIAnalysisResult> {
	console.info({ tag: 'AI', msg: 'Analyzing', title: article.title.substring(0, 80) });

	try {
		const result = await generateObject<ArticleAnalysisObject>(ai, buildArticleAnalysisPrompt(article), {
			schema: ArticleAnalysisSchema,
			schemaName: 'article analysis',
			task: AI_TASKS.articleAnalysis,
			maxTokens: 1000,
			systemPrompt: ARTICLE_ANALYSIS_SYSTEM_PROMPT,
		});
		if (!result) throw new Error('Invalid structured response');

		return {
			tags: result.tags.slice(0, 5),
			keywords: result.keywords.slice(0, 8),
			summary_en: result.summary_en,
			summary_cn: result.summary_cn,
			title_en: result.title_en,
			title_cn: result.title_cn,
			category: result.category ?? 'Other',
			entities: Array.isArray(result.entities) ? result.entities.slice(0, 10) : [],
		};
	} catch (error) {
		console.error({ tag: 'AI', msg: 'Parse failed', error: String(error) });
		return createFallbackResult(article);
	}
}
