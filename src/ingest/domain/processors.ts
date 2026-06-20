import { prepareArticleTextForEmbedding } from '@shared/embedding';
import { type PlatformEnrichments, type PlatformMetadata, withOgDimensions } from '@shared/platform-metadata';
import type { Article } from '@shared/types';
import { type ArticleProcessor, generateArticleAnalysis, isEmpty, type ProcessorContext, type ProcessorResult } from './ai-utils';

export type { ProcessorResult } from './ai-utils';

// ─────────────────────────────────────────────────────────────
// Default Processor
// ─────────────────────────────────────────────────────────────

class DefaultProcessor implements ArticleProcessor {
	async process(article: Article, ctx: ProcessorContext): Promise<ProcessorResult> {
		const analysis = await generateArticleAnalysis(article, ctx.env.AI);
		const updateData: ProcessorResult['updateData'] = {};

		const allTags = [...new Set([...analysis.tags, analysis.category])];

		if (!article.tags?.length) updateData.tags = allTags;
		if (!article.keywords?.length) updateData.keywords = analysis.keywords;
		if (isEmpty(article.title_cn)) updateData.title_cn = analysis.title_cn;
		if (isEmpty(article.summary)) updateData.summary = analysis.summary_en;
		if (isEmpty(article.summary_cn)) updateData.summary_cn = analysis.summary_cn;
		if (analysis.entities?.length) updateData.entities = analysis.entities;

		return { updateData };
	}
}

// ─────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────

import { HackerNewsProcessor } from '../platforms/hackernews/processor';
import { TwitterProcessor } from '../platforms/twitter/processor';

const processors: Record<string, ArticleProcessor> = {
	hackernews: new HackerNewsProcessor(),
	twitter: new TwitterProcessor(),
	default: new DefaultProcessor(),
};

function getProcessor(sourceType: string | undefined): ArticleProcessor {
	return processors[sourceType ?? 'default'] ?? processors.default;
}

function mergePlatformMetadata(
	baseMetadata: PlatformMetadata | null | undefined,
	enrichments?: PlatformEnrichments,
	ogImageDimensions?: { width: number; height: number },
): PlatformMetadata | null {
	const hasEnrichments = !!enrichments && Object.keys(enrichments).length > 0;
	const hasDims = !!ogImageDimensions && ogImageDimensions.width > 0 && ogImageDimensions.height > 0;
	if (!hasEnrichments && !hasDims) return baseMetadata ?? null;

	// Dimensions can stand alone — they synthesize a `default` envelope when the
	// article has none yet. Enrichments still require a base envelope (they
	// describe an already-typed platform), so an enrichments-only merge with no
	// base is dropped, matching the prior behavior.
	let result = hasDims ? withOgDimensions(baseMetadata, ogImageDimensions.width, ogImageDimensions.height) : (baseMetadata ?? null);
	if (!result) return null;

	if (hasEnrichments) {
		result = {
			...result,
			enrichments: { ...(result.enrichments || {}), ...enrichments, processedAt: new Date().toISOString() },
		};
	}
	return result;
}

export async function runArticleProcessor(
	article: Article,
	sourceType: string | undefined,
	deps: ProcessorContext,
): Promise<ProcessorResult> {
	return getProcessor(sourceType).process(article, deps);
}

export function buildProcessorUpdatePayload(
	article: Article,
	result: ProcessorResult,
	embedding?: number[] | null,
	metadataPatch?: Record<string, unknown>,
): Record<string, unknown> {
	const mergedMetadata = mergePlatformMetadata(article.platform_metadata, result.enrichments, result.ogImageDimensions);
	const updatePayload: Record<string, unknown> = { ...result.updateData };
	if (metadataPatch) updatePayload.platform_metadata = { ...(mergedMetadata ?? article.platform_metadata ?? {}), ...metadataPatch };
	else if (mergedMetadata) updatePayload.platform_metadata = mergedMetadata;
	if (embedding?.length) updatePayload.embedding = `[${embedding.join(',')}]`;
	return updatePayload;
}

export function buildEmbeddingTextForArticle(
	article: Pick<Article, 'title' | 'summary' | 'content' | 'tags' | 'keywords'>,
	result: ProcessorResult,
): string {
	return prepareArticleTextForEmbedding({
		title: article.title,
		summary: result.updateData.summary ?? article.summary,
		content: result.updateData.content ?? article.content,
		tags: result.updateData.tags ?? article.tags,
		keywords: result.updateData.keywords ?? article.keywords,
	});
}
