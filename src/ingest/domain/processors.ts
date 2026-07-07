import type { ArticleCategory, PlatformMetadata } from '@core-shared/platform-metadata';
import type { Article } from '@core-shared/types';
import { type ArticleProcessor, generateArticleAnalysis, isEmpty, type ProcessorContext, type ProcessorResult } from './ai-utils';

export type { ProcessorResult } from './ai-utils';

// ─────────────────────────────────────────────────────────────
// Default Processor
// ─────────────────────────────────────────────────────────────

class DefaultProcessor implements ArticleProcessor {
	async process(article: Article, ctx: ProcessorContext): Promise<ProcessorResult> {
		const analysis = await generateArticleAnalysis(article, ctx.env);
		const updateData: ProcessorResult['updateData'] = {};

		const allTags = [...new Set([...(analysis.tags ?? []), ...(analysis.category ? [analysis.category] : [])])];

		if (!article.tags?.length && allTags.length) updateData.tags = allTags;
		if (!article.keywords?.length && analysis.keywords?.length) updateData.keywords = analysis.keywords;
		if (isEmpty(article.title_cn) && analysis.title_cn) updateData.title_cn = analysis.title_cn;
		if (isEmpty(article.summary) && analysis.summary_en) updateData.summary = analysis.summary_en;
		if (isEmpty(article.summary_cn) && analysis.summary_cn) updateData.summary_cn = analysis.summary_cn;
		if (analysis.content) updateData.content = analysis.content;
		if (isEmpty(article.content_cn) && analysis.content_cn) updateData.content_cn = analysis.content_cn;
		if (analysis.entities) updateData.entities = analysis.entities;

		return { updateData, classificationCategory: analysis.category };
	}
}

// ─────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────

import { HackerNewsProcessor } from '../platforms/hackernews/processor';
import { TwitterProcessor } from '../platforms/twitter/processor';

export const articleProcessors: Record<string, ArticleProcessor> = {
	hackernews: new HackerNewsProcessor(),
	twitter: new TwitterProcessor(),
	default: new DefaultProcessor(),
};

const ARTICLE_CATEGORIES = new Set<ArticleCategory>(['AI', 'Tech', 'Finance', 'Research', 'Business', 'Other']);

export function buildProcessorUpdatePayload(
	article: Article,
	result: ProcessorResult,
	embedding?: number[] | null,
	metadataPatch?: Record<string, unknown>,
): Record<string, unknown> {
	const updatePayload: Record<string, unknown> = { ...result.updateData };
	const category =
		result.classificationCategory ??
		(Array.isArray(updatePayload.tags)
			? updatePayload.tags.find((tag): tag is ArticleCategory => typeof tag === 'string' && ARTICLE_CATEGORIES.has(tag as ArticleCategory))
			: null);
	const hasEnrichments = !!result.enrichments && Object.keys(result.enrichments).length > 0;
	let mergedMetadata: PlatformMetadata | null = article.platform_metadata ?? null;
	if (hasEnrichments && mergedMetadata) {
		mergedMetadata = {
			...mergedMetadata,
			enrichments: { ...(mergedMetadata.enrichments || {}), ...result.enrichments, processedAt: new Date().toISOString() },
		};
	}
	if (category) {
		const base = mergedMetadata ??
			article.platform_metadata ?? { type: 'default' as const, fetchedAt: new Date().toISOString(), data: null };
		mergedMetadata = {
			...base,
			classification: {
				...(base.classification ?? {}),
				category,
				classifiedAt: new Date().toISOString(),
			},
		};
	}
	if (metadataPatch) updatePayload.platform_metadata = { ...(mergedMetadata ?? article.platform_metadata ?? {}), ...metadataPatch };
	else if (mergedMetadata) updatePayload.platform_metadata = mergedMetadata;
	if (embedding?.length) updatePayload.embedding = `[${embedding.join(',')}]`;
	return updatePayload;
}
