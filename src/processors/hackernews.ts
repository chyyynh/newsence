import { Article } from '../types';
import { ProcessorResult, ProcessorContext, ArticleProcessor } from './types';
import { callGeminiForAnalysis } from '../utils/ai';
import { isEmpty, callOpenRouterChat } from './base';

const HN_ALGOLIA_API = 'https://hn.algolia.com/api/v1/items';

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

// 遞迴收集所有評論
function collectAllComments(children: HnComment[]): string[] {
	const comments: string[] = [];
	for (const child of children) {
		if (child.text) {
			// 移除 HTML 標籤
			const cleanText = child.text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
			if (cleanText) comments.push(cleanText);
		}
		if (child.children?.length) {
			comments.push(...collectAllComments(child.children));
		}
	}
	return comments;
}

// 用 AI 整理 HN 討論
async function summarizeDiscussion(
	apiKey: string,
	title: string,
	comments: string[]
): Promise<string | null> {
	if (comments.length === 0) return null;

	const allText = comments.join('\n---\n').slice(0, 25000);

	const systemPrompt =
		'You summarize Hacker News discussions. Extract key insights, main arguments, and interesting perspectives. Be concise (150-200 words). Use bullet points. Write in English.';

	const userPrompt = `Summarize the discussion about: "${title}"\n\nComments:\n${allText}`;

	return callOpenRouterChat(apiKey, systemPrompt, userPrompt, 400);
}

// 從 platform_metadata 提取 HN item ID
function extractItemId(article: Article): string | null {
	const metadata = article.platform_metadata as { data?: { itemId?: string } } | undefined;
	return metadata?.data?.itemId || null;
}

export class HackerNewsProcessor implements ArticleProcessor {
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
				const summary = await summarizeDiscussion(
					ctx.env.OPENROUTER_API_KEY,
					article.title,
					comments
				);
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
			enrichments.hnText = hnData.text || null; // Ask HN 內文
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
