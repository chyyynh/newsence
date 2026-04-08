// ─────────────────────────────────────────────────────────────
// HackerNews Processor
// ─────────────────────────────────────────────────────────────

import {
	type ArticleProcessor,
	callGeminiForAnalysis,
	callOpenRouterChat,
	isEmpty,
	type ProcessorContext,
	type ProcessorResult,
} from '../../domain/ai-utils';
import { logError, logInfo, logWarn } from '../../infra/log';
import type { PlatformEnrichments } from '../../models/platform-metadata';
import type { Article, Env } from '../../models/types';
import { scrapeWebPage } from '../web/scraper';
import { HN_ALGOLIA_API } from './scraper';

// ─────────────────────────────────────────────────────────────
// Types
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

export interface HnCollectedComment {
	id?: number;
	author?: string;
	text: string;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// Editorial Prompts
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// HackerNewsProcessor class
// ─────────────────────────────────────────────────────────────

export class HackerNewsProcessor implements ArticleProcessor {
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
		if (analysis.entities?.length) updateData.entities = analysis.entities;

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

	private async fetchExternalPage(url: string | undefined, _env: Env): Promise<{ title: string | null; content: string | null }> {
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
