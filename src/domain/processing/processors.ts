import { USER_FILES_TABLE } from '../../infra/db';
import { prepareArticleTextForEmbedding } from '../../infra/embedding';
import type { PlatformEnrichments, PlatformMetadata } from '../../models/platform-metadata';
import type { Article } from '../../models/types';
import {
	type ArticleProcessor,
	callGeminiForAnalysis,
	isEmpty,
	type ProcessingDeps,
	type ProcessorContext,
	type ProcessorResult,
} from './ai-utils';

export { collectAllComments } from '../../platforms/hackernews/processor';
export { translateTweet } from '../../platforms/twitter/processor';
export { generateYouTubeHighlights, type YouTubeHighlight, type YouTubeHighlightsResult } from '../../platforms/youtube/highlights';
export type { ArticleProcessor, ProcessingDeps, ProcessorContext, ProcessorResult } from './ai-utils';
// Re-exports
export { callGeminiForAnalysis, callOpenRouterChat, createFallbackResult, isEmpty, translateContent } from './ai-utils';

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
		if (analysis.entities?.length) updateData.entities = analysis.entities;

		return { updateData };
	}
}

// ─────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────

import { HackerNewsProcessor } from '../../platforms/hackernews/processor';
import { TwitterProcessor } from '../../platforms/twitter/processor';

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
	return getProcessor(sourceType).process(article, deps);
}

// `user_files` carries the same editorial fields as `articles` but with a few
// different column names (content/extracted_text, url/source_url, etc.). The
// processor emits keys that match `articles` column names; remap them when
// the target table is user_files.
const ARTICLES_TO_USER_FILES_COLUMN_MAP: Record<string, string> = {
	content: 'extracted_text',
	url: 'source_url',
	source: 'site_name',
	platform_metadata: 'metadata',
	scraped_date: 'created_at',
};

function mapColumnForTable(column: string, table: string): string {
	if (table !== USER_FILES_TABLE) return column;
	return ARTICLES_TO_USER_FILES_COLUMN_MAP[column] ?? column;
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
	const setClauses = columns.map((col, i) => `${mapColumnForTable(col, deps.table)} = $${i + 1}`).join(', ');
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
	article: Pick<Article, 'title' | 'title_cn' | 'summary' | 'summary_cn' | 'content' | 'content_cn' | 'tags' | 'keywords'>,
	result: ProcessorResult,
): string {
	return prepareArticleTextForEmbedding({
		title: article.title,
		title_cn: result.updateData.title_cn ?? article.title_cn,
		summary: result.updateData.summary ?? article.summary,
		summary_cn: result.updateData.summary_cn ?? article.summary_cn,
		content: result.updateData.content ?? article.content,
		content_cn: result.updateData.content_cn ?? article.content_cn,
		tags: result.updateData.tags ?? article.tags,
		keywords: result.updateData.keywords ?? article.keywords,
	});
}
