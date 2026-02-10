import { Article, Env } from '../models/types';
import { callGeminiForAnalysis, callOpenRouter, AI_MODELS, translateTweet, extractJson } from '../infra/ai';
import { scrapeWebPage } from './scrapers';
import { prepareArticleTextForEmbedding } from '../infra/embedding';
import { HN_ALGOLIA_API } from './scrapers';

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

export interface ProcessingDeps {
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

async function translateContent(content: string, apiKey: string): Promise<string | null> {
	const prompt = `請將以下文章內容翻譯成繁體中文。保持 Markdown 格式，包括標題、段落、列表等。只翻譯，不要添加任何額外內容。

${content}`;

	return callOpenRouter(prompt, { apiKey, model: AI_MODELS.FLASH, maxTokens: 8000 });
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

		if (isEmpty(article.content_cn) && !isEmpty(article.content)) {
			const contentCn = await translateContent(article.content!, ctx.env.OPENROUTER_API_KEY);
			if (contentCn) updateData.content_cn = contentCn;
		}

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
			console.log(`[TWITTER-PROCESSOR] Processing Twitter Article: ${article.title.slice(0, 50)}`);
			const analysis = await callGeminiForAnalysis(article, ctx.env.OPENROUTER_API_KEY);

			if (isEmpty(article.title_cn)) updateData.title_cn = analysis.title_cn;
			if (isEmpty(article.summary)) updateData.summary = analysis.summary_en;
			if (isEmpty(article.summary_cn)) updateData.summary_cn = analysis.summary_cn;
			if (!article.tags?.length) updateData.tags = [...new Set([...analysis.tags, analysis.category])];
			if (!article.keywords?.length) updateData.keywords = analysis.keywords;

			// Translate full article content to Chinese
			const contentCn = await translateContent(article.content!, ctx.env.OPENROUTER_API_KEY);
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

					const contentCn = await translateContent(linked.content, ctx.env.OPENROUTER_API_KEY);
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

interface HnSourceRef {
	id: string;
	label: string;
	url: string;
}

interface StructuredHnFocus {
	title: string;
	detail: string;
	sources?: string[];
}

interface StructuredHnTerm {
	term: string;
	definition: string;
}

interface StructuredHnOutput {
	title_line: string;
	hook: string;
	background: string;
	focuses: StructuredHnFocus[];
	terms: StructuredHnTerm[];
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

async function summarizeDiscussion(apiKey: string, title: string, comments: HnCollectedComment[]): Promise<string | null> {
	if (comments.length === 0) return null;

	const allText = comments
		.map((comment, index) => `${index + 1}. ${comment.author ? `${comment.author}: ` : ''}${comment.text}`)
		.join('\n---\n')
		.slice(0, 25000);
	const systemPrompt = 'You summarize Hacker News discussions. Extract key insights, main arguments, and interesting perspectives. Be concise (150-200 words). Use bullet points. Write in English.';
	const userPrompt = `Summarize the discussion about: "${title}"\n\nComments:\n${allText}`;

	return callOpenRouterChat(apiKey, systemPrompt, userPrompt, 400);
}

function buildHnSources(
	hnData: HnItemData,
	comments: HnCollectedComment[],
	externalPageTitle?: string | null
): HnSourceRef[] {
	const hnUrl = `https://news.ycombinator.com/item?id=${hnData.id}`;
	const sources: HnSourceRef[] = [{ id: 'hn', label: 'Hacker News discussion', url: hnUrl }];

	if (hnData.url) {
		sources.unshift({
			id: 'article',
			label: externalPageTitle?.trim() || hnData.title || hnData.url,
			url: hnData.url,
		});
	}

	const topComments = comments.filter((comment) => comment.text.length >= 40).slice(0, 6);
	for (let i = 0; i < topComments.length; i++) {
		const comment = topComments[i];
		sources.push({
			id: `c${i + 1}`,
			label: `HN comment ${i + 1}${comment.author ? ` by ${comment.author}` : ''}`,
			url: comment.id ? `${hnUrl}#${comment.id}` : hnUrl,
		});
	}

	return sources;
}

function shouldBuildRichContent(comments: HnCollectedComment[], externalPageContent?: string | null): boolean {
	if (comments.length >= 4) return true;
	return Boolean(externalPageContent && externalPageContent.length >= 600);
}

async function buildStructuredHnContent(
	apiKey: string,
	article: Article,
	hnData: HnItemData,
	comments: HnCollectedComment[],
	sources: HnSourceRef[],
	externalPageContent?: string | null
): Promise<string | null> {
	if (!shouldBuildRichContent(comments, externalPageContent)) return null;

	const sourceCatalog = sources.map((source) => `- ${source.id}: ${source.label} (${source.url})`).join('\n');
	const commentInput = comments
		.slice(0, 24)
		.map((comment, index) => `c${index + 1}: ${comment.author ? `${comment.author}: ` : ''}${comment.text}`)
		.join('\n');
	const pageExcerpt = externalPageContent?.slice(0, 6000) ?? '';

	const systemPrompt =
		'You structure Hacker News threads into concise Chinese editorial notes. Use only provided material. Output strict JSON.';
	const userPrompt = `根據資料整理成繁體中文內容，回傳 JSON，不要其他文字。

標題: ${article.title}
HN 主文簡介: ${cleanHtmlText(hnData.text || '').slice(0, 1200) || '無'}
外部文章節錄:
${pageExcerpt || '無'}

留言樣本:
${commentInput || '無'}

可用來源 ID:
${sourceCatalog}

輸出格式:
{
  "title_line": "一句警示或重點標題",
  "hook": "一句短副標",
  "background": "2-4 句背景",
  "focuses": [
    {
      "title": "焦點標題",
      "detail": "3-6 句重點整理",
      "sources": ["article", "hn", "c1"]
    }
  ],
  "terms": [
    {
      "term": "術語",
      "definition": "1-2 句簡短解釋"
    }
  ]
}

限制:
- focuses 3-6 個
- terms 3-8 個
- sources 只能用可用來源 ID
- detail 不要抄原文，做歸納
- 不要產生虛構來源 ID`;

	const raw = await callOpenRouterChat(apiKey, systemPrompt, userPrompt, 1800);
	if (!raw) return null;

	const parsed = extractJson<StructuredHnOutput>(raw);
	if (!parsed || !parsed.title_line || !parsed.background || !Array.isArray(parsed.focuses) || parsed.focuses.length === 0) {
		return null;
	}

	return renderStructuredHnContent(parsed, sources);
}

export function renderStructuredHnContent(parsed: StructuredHnOutput, sources: HnSourceRef[]): string {
	const sourceIndex = new Map<string, number>();
	sources.forEach((source, index) => sourceIndex.set(source.id, index + 1));

	const lines: string[] = [];
	lines.push('---');
	lines.push(`⚠️${parsed.title_line.trim()}`);
	lines.push(parsed.hook?.trim() || '');
	lines.push('');
	lines.push('🎯 討論背景');
	lines.push(parsed.background.trim());
	lines.push('');
	lines.push('📌 討論焦點');

	for (const focus of parsed.focuses) {
		const title = focus.title?.trim();
		const detail = focus.detail?.trim();
		if (!title || !detail) continue;
		lines.push(title);
		lines.push(detail);
		const refs = (focus.sources ?? [])
			.map((sourceId) => sourceIndex.get(sourceId))
			.filter((value): value is number => typeof value === 'number')
			.map((num) => `[來源${num}]`);
		if (refs.length > 0) lines.push(refs.join(' '));
		lines.push('');
	}

	if (Array.isArray(parsed.terms) && parsed.terms.length > 0) {
		lines.push('📚 術語解釋');
		for (const term of parsed.terms) {
			const termName = term.term?.trim();
			const definition = term.definition?.trim();
			if (!termName || !definition) continue;
			lines.push(`${termName}: ${definition}`);
		}
		lines.push('');
	}

	lines.push('🔗 來源');
	sources.forEach((source, index) => {
		lines.push(`[來源${index + 1}] ${source.label} (${source.url})`);
	});

	return lines.join('\n').trim();
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
		const updateData: ProcessorResult['updateData'] = {};

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

		// 2. 收集評論與外部文章（若有）
		let comments: HnCollectedComment[] = [];
		if (hnData?.children?.length) {
			comments = collectAllComments(hnData.children);
			console.log(`[HN-PROCESSOR] Collected ${comments.length} comments for ${article.title.slice(0, 50)}...`);
		}

		let externalPageTitle: string | null = null;
		let externalPageContent: string | null = null;
		if (hnData?.url) {
			try {
				const page = await scrapeWebPage(hnData.url);
				externalPageTitle = page.title || null;
				externalPageContent = page.content || null;
			} catch (error) {
				console.warn('[HN-PROCESSOR] Failed to scrape linked webpage:', error);
			}
		}

		// 3. 留言摘要
		if (hnData?.children?.length) {
			if (comments.length > 0) {
				const summary = await summarizeDiscussion(ctx.env.OPENROUTER_API_KEY, article.title, comments);
				if (summary) {
					enrichments.discussionSummary = summary;
					console.log(`[HN-PROCESSOR] Generated discussion summary (${summary.length} chars)`);
				}
			}
		}

		// 4. 生成結構化 content（含網頁背景 + 留言整理）
		if (hnData) {
			const sources = buildHnSources(hnData, comments, externalPageTitle);
			const structuredContent = await buildStructuredHnContent(
				ctx.env.OPENROUTER_API_KEY,
				article,
				hnData,
				comments,
				sources,
				externalPageContent
			);

			if (structuredContent) {
				updateData.content_cn = structuredContent;
				enrichments.structuredSourceCount = sources.length;
				console.log(`[HN-PROCESSOR] Generated structured content_cn (${structuredContent.length} chars)`);
			}
			if (externalPageContent) {
				updateData.content = externalPageContent;
				console.log(`[HN-PROCESSOR] Set content from external page (${externalPageContent.length} chars)`);
			}
		}

		// 5. 存儲額外的 HN 資訊
		if (hnData) {
			enrichments.hnUrl = `https://news.ycombinator.com/item?id=${hnData.id}`;
			enrichments.externalUrl = hnData.url || null;
			enrichments.hnText = hnData.text || null;
		}

		// 6. 呼叫通用 AI 分析
		const analysis = await callGeminiForAnalysis(article, ctx.env.OPENROUTER_API_KEY);

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

export function mergePlatformMetadata(
	baseMetadata: Article['platform_metadata'] | null | undefined,
	enrichments?: Record<string, unknown>
): Article['platform_metadata'] | null {
	if (!baseMetadata && (!enrichments || Object.keys(enrichments).length === 0)) return baseMetadata ?? null;
	if (!enrichments || Object.keys(enrichments).length === 0) return baseMetadata ?? null;

	const metadata = baseMetadata ?? {};
	return {
		...metadata,
		enrichments: {
			...(metadata.enrichments || {}),
			...enrichments,
			processedAt: new Date().toISOString(),
		},
	};
}

export async function runArticleProcessor(
	article: Article,
	sourceType: string | undefined,
	deps: ProcessingDeps
): Promise<ProcessorResult> {
	const processor = getProcessor(sourceType);
	const ctx: ProcessorContext = {
		env: deps.env,
		supabase: deps.supabase,
		table: deps.table,
	};
	return processor.process(article, ctx);
}

export async function persistProcessorResult(
	articleId: string,
	article: Article,
	result: ProcessorResult,
	deps: ProcessingDeps
): Promise<void> {
	if (Object.keys(result.updateData).length > 0) {
		const { error } = await deps.supabase.from(deps.table).update(result.updateData).eq('id', articleId);
		if (error) throw new Error(`Failed to update article ${articleId}: ${error.message}`);
	}

	const mergedMetadata = mergePlatformMetadata(article.platform_metadata, result.enrichments);
	if (mergedMetadata) {
		const { error } = await deps.supabase.from(deps.table).update({ platform_metadata: mergedMetadata }).eq('id', articleId);
		if (error) throw new Error(`Failed to update metadata for ${articleId}: ${error.message}`);
	}
}

export function buildEmbeddingTextForArticle(
	article: Pick<Article, 'title' | 'title_cn' | 'summary' | 'summary_cn' | 'tags' | 'keywords'>,
	result: ProcessorResult
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
