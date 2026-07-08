import type { ArticleCategory, PlatformMetadata } from '@core-shared/platform-metadata';
import type { Article } from '@core-shared/types';
import { HackerNewsProcessor } from '../platforms/hackernews/scraper';
import { TwitterProcessor } from '../platforms/twitter/processor';
import { type ArticleProcessor, generateArticleAnalysis, mergeArticleAnalysis, type ProcessorResult } from './ai-utils';

const defaultProcessor: ArticleProcessor = {
	async process(article, ctx) {
		const analysis = await generateArticleAnalysis(article, ctx.env);
		return mergeArticleAnalysis(article, analysis);
	},
};
const twitterProcessor = new TwitterProcessor();

export const articlePlatforms: Record<string, ArticleProcessor> = {
	hackernews: new HackerNewsProcessor(),
	rss: defaultProcessor,
	twitter: twitterProcessor,
	web: defaultProcessor,
	youtube: defaultProcessor,
	default: defaultProcessor,
};

export function platformIdentity(article: Article): string {
	return article.platform_metadata?.type ?? article.source_type ?? 'default';
}

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
