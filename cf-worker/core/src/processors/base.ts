import { Article } from '../types';
import { ProcessorResult, ProcessorContext, ArticleProcessor } from './types';
import { callGeminiForAnalysis } from '../utils/ai';

// 共用工具：檢查欄位是否為空
export function isEmpty(value: string | null | undefined): boolean {
	return !value?.trim();
}

// 共用工具：OpenRouter API 調用
const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';

export async function callOpenRouterChat(
	apiKey: string,
	systemPrompt: string,
	userPrompt: string,
	maxTokens = 500
): Promise<string | null> {
	try {
		const response = await fetch(OPENROUTER_API, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
				'HTTP-Referer': 'https://app.newsence.xyz',
				'X-Title': 'app.newsence.xyz',
			},
			body: JSON.stringify({
				model: 'google/gemini-2.0-flash-001',
				messages: [
					{ role: 'system', content: systemPrompt },
					{ role: 'user', content: userPrompt },
				],
				max_tokens: maxTokens,
			}),
		});

		if (!response.ok) {
			console.error(`[PROCESSOR] OpenRouter error: ${response.status}`);
			return null;
		}

		const data = (await response.json()) as {
			choices?: Array<{ message?: { content?: string } }>;
		};

		return data.choices?.[0]?.message?.content || null;
	} catch (error) {
		console.error('[PROCESSOR] OpenRouter call failed:', error);
		return null;
	}
}

// 預設 Processor：處理一般 RSS 文章
export class DefaultProcessor implements ArticleProcessor {
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
