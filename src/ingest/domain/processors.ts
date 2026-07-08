import type { ArticleCategory, PlatformMetadata } from '@core-shared/platform-metadata';
import type { Article, WorkflowAttachment } from '@core-shared/types';
import { persistYouTubeWorkflowData, prepareYouTubeHighlights, type YouTubeHighlightsUpdate } from '@ingest/platforms/youtube/transcripts';
import type { Client } from 'pg';
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

import { HackerNewsProcessor } from '../platforms/hackernews/scraper';
import { TwitterProcessor, upsertTwitterSourceEventAttachment } from '../platforms/twitter/processor';

export type PlatformWorkflowData = { type: 'youtube'; highlights: YouTubeHighlightsUpdate };

type PlatformWorkflowPersistenceInput = {
	articleId: string;
	data?: PlatformWorkflowData | null;
	attachments?: WorkflowAttachment[];
};

export type ArticlePlatformAdapter = ArticleProcessor & {
	prepareWorkflowData?: (
		article: Article,
		ctx: ProcessorContext,
		attachments?: WorkflowAttachment[],
	) => Promise<PlatformWorkflowData | null>;
	persistWorkflowData?: (db: Client, input: PlatformWorkflowPersistenceInput) => Promise<void>;
};

const defaultProcessor = new DefaultProcessor();
const twitterProcessor = new TwitterProcessor();

export const articlePlatforms: Record<string, ArticlePlatformAdapter> = {
	hackernews: new HackerNewsProcessor(),
	twitter: {
		process: (article, ctx) => twitterProcessor.process(article, ctx),
		persistWorkflowData: (db, input) => upsertTwitterSourceEventAttachment(db, input.articleId, input.attachments),
	},
	youtube: {
		process: (article, ctx) => defaultProcessor.process(article, ctx),
		async prepareWorkflowData(article, ctx, attachments) {
			const highlights = await prepareYouTubeHighlights(ctx.env, article, attachments);
			return highlights ? { type: 'youtube', highlights } : null;
		},
		persistWorkflowData: (db, input) =>
			persistYouTubeWorkflowData(db, {
				attachments: input.attachments,
				highlights: input.data?.type === 'youtube' ? input.data.highlights : null,
			}),
	},
	default: defaultProcessor,
};

export function getArticlePlatform(sourceType?: string | null): ArticlePlatformAdapter {
	return articlePlatforms[sourceType ?? ''] ?? articlePlatforms.default;
}

export function getArticlePlatformForArticle(article: Article): ArticlePlatformAdapter {
	return getArticlePlatform(article.platform_metadata?.type ?? article.source_type);
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
