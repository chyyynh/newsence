import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { generateArticleEmbedding, prepareArticleTextForEmbedding } from '@core-ai/embedding';
import type { Article, PaperMetadata, PlatformMetadata, YoutubeTranscript } from '@core-shared/types';
import { type CoreDb, withCoreTx } from '@db/client';
import { normalizeArticleEntityUpdatePayload } from '@entities/normalize';
import {
	insertFinalSourceArticle,
	loadArticleForProcessing,
	syncArticleEntities,
	syncResourceAfterProcessing,
	syncResourceEntities,
	updateArticleAfterProcessing,
} from '@ingest/domain/article-store';
import {
	type AcquiredContent,
	EMPTY_OG_IMAGE_PATCH,
	fetchOgImage,
	type OgImagePatch,
	PDF_MIME,
	pdfExtractionMetadata,
	readAcquiredContentArtifact,
	scrapeSavedUrlArtifact,
} from './acquisition';
import { generateArticleAnalysis, mergeArticleAnalysis, type ProcessorResult } from './domain/ai-utils';
import { processHackerNewsArticle } from './platforms/hackernews';
import { stagePaperEnrichment, syncPaperGraphForEnrichment } from './platforms/paper';
import { type PdfTextArtifact, stagePdfTextExtraction } from './platforms/pdf';
import { processTwitterArticle } from './platforms/twitter';
import { persistYouTubeWorkflowData, prepareYouTubeHighlights } from './platforms/youtube';

function sourceRecordToArticle(data: SourceArticleRecord): Article {
	return {
		id: data.url,
		title: data.title,
		title_cn: null,
		summary: data.summary || null,
		summary_cn: null,
		content: data.content,
		content_cn: null,
		url: data.url,
		source: data.source,
		published_date: typeof data.publishedDate === 'string' ? data.publishedDate : data.publishedDate.toISOString(),
		tags: data.tags ?? [],
		keywords: data.keywords ?? [],
		source_type: data.sourceType,
		platform_metadata: data.platformMetadata as Article['platform_metadata'],
	};
}

function buildProcessorUpdatePayload(
	article: Article,
	result: ProcessorResult,
	embedding?: number[] | null,
	metadataPatch?: Record<string, unknown>,
): Record<string, unknown> {
	const updatePayload: Record<string, unknown> = { ...result.updateData };
	const category = result.classificationCategory;
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

type StoredWorkflowTarget = { kind: 'article' | 'userFile'; rowId: string; reacquire?: boolean };

type WorkflowTarget = StoredWorkflowTarget | { kind: 'source'; draft: SourceArticleDraft };
type SourceWorkflowTarget = Extract<WorkflowTarget, { kind: 'source' }>;
type SourceArticleRecord = Parameters<typeof insertFinalSourceArticle>[1];
type PersistedTargetIds = { legacyId: string; resourceId: string };

interface SourceArticleDraft {
	article: SourceArticleRecord;
	youtubeTranscript?: YoutubeTranscript;
}

const ACTIVE_WORKFLOW_STATUSES = new Set(['queued', 'running', 'paused', 'waiting', 'waitingForPause']);

export async function enqueueProcessing(env: CoreEnv, target: WorkflowTarget): Promise<string> {
	const workflowId = target.kind === 'source' ? await sourceArticleWorkflowId(target.draft.article.url) : storedWorkflowId(target);
	const [created] = await env.MONITOR_WORKFLOW.createBatch([{ id: workflowId, params: { target } }]);
	if (created) return created.id;

	const instance = await env.MONITOR_WORKFLOW.get(workflowId);
	const { status } = await instance.status();
	if (ACTIVE_WORKFLOW_STATUSES.has(status) || (target.kind === 'source' && status === 'complete')) return instance.id;

	await instance.restart();
	return instance.id;
}

function workflowIdPart(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
}

function storedTargetTable(target: StoredWorkflowTarget): 'articles' | 'user_files' {
	return target.kind === 'article' ? 'articles' : 'user_files';
}

function storedWorkflowId(target: StoredWorkflowTarget): string {
	return [target.reacquire ? 'article-reacquire' : 'article', workflowIdPart(storedTargetTable(target)), workflowIdPart(target.rowId)].join(
		'-',
	);
}

async function sourceArticleWorkflowId(url: string): Promise<string> {
	const bytes = new TextEncoder().encode(url);
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	const hash = [...new Uint8Array(digest)]
		.slice(0, 16)
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
	return `source-article-${hash}`;
}

function applyAcquiredContent(article: Article, acquired: AcquiredContent | null): Article {
	if (!acquired) return article;
	const acquiredTitle = acquired.title?.trim();
	const acquiredSourceType = acquired.platformMetadata?.type;
	return {
		...article,
		title: acquiredTitle || article.title,
		summary: acquired.metadata.description ?? article.summary,
		content: acquired.markdown || article.content,
		source: acquired.metadata.siteName ?? acquired.metadata.author ?? article.source,
		published_date: acquired.metadata.publishedDate ?? article.published_date,
		source_type:
			article.source_type === 'rss' && acquiredSourceType === 'default' ? article.source_type : (acquiredSourceType ?? article.source_type),
		platform_metadata: acquired.platformMetadata ?? article.platform_metadata,
		file_type: acquired.platformMetadata?.type === 'pdf' ? PDF_MIME : article.file_type,
	};
}

function acquiredContentUpdatePayload(
	acquired: AcquiredContent | null,
	options?: { preserveSourceType?: boolean },
): Record<string, unknown> {
	if (!acquired) return {};
	const acquiredTitle = acquired.title?.trim();
	return {
		...(acquiredTitle ? { title: acquiredTitle } : {}),
		...(acquired.metadata.siteName || acquired.metadata.author ? { source: acquired.metadata.siteName ?? acquired.metadata.author } : {}),
		...(acquired.metadata.publishedDate ? { published_date: acquired.metadata.publishedDate } : {}),
		...(acquired.metadata.description !== null ? { summary: acquired.metadata.description } : {}),
		content: acquired.markdown,
		...(acquired.platformMetadata
			? {
					...(options?.preserveSourceType ? {} : { source_type: acquired.platformMetadata.type }),
					platform_metadata: acquired.platformMetadata,
				}
			: {}),
	};
}

function withoutPlatformMetadata(payload: Record<string, unknown>): Record<string, unknown> {
	const { platform_metadata: _platformMetadata, ...rest } = payload;
	return rest;
}

function ogImageUpdatePayload(patch: OgImagePatch): Record<string, unknown> {
	const metadataPatch =
		patch.ogImageWidth && patch.ogImageHeight ? { ogImageWidth: patch.ogImageWidth, ogImageHeight: patch.ogImageHeight } : null;
	return {
		...(patch.ogImageUrl ? { og_image_url: patch.ogImageUrl } : {}),
		...(metadataPatch ? { platform_metadata: metadataPatch } : {}),
	};
}

function mergeMetadataPatch(...patches: Array<unknown>): Record<string, unknown> | undefined {
	const records = patches.filter(
		(patch): patch is Record<string, unknown> => !!patch && typeof patch === 'object' && !Array.isArray(patch),
	);
	if (!records.length) return undefined;
	return Object.assign({}, ...records);
}

function paperMetadataPatch(paperEnrichment: PaperMetadata | null): Record<string, unknown> | undefined {
	return paperEnrichment ? { type: 'paper', data: paperEnrichment } : undefined;
}

function shouldAcquireContent(target: WorkflowTarget, article: Article): boolean {
	const hasContent = 'has_content' in article && !!article.has_content;
	if (target.kind === 'userFile') return !hasContent && !article.storage_key && !!article.url;
	if (target.kind === 'article' && target.reacquire) {
		return (
			!!article.url && !article.storage_key && (!article.source_type || article.source_type === 'rss' || article.source_type === 'default')
		);
	}
	return target.kind === 'source' && (article.source_type === 'rss' || article.source_type === 'default');
}

function sourceArticleBase(article: Article, fallback: SourceArticleRecord): SourceArticleRecord {
	return {
		...fallback,
		url: article.url || fallback.url,
		title: article.title || fallback.title,
		source: article.source || fallback.source,
		publishedDate: article.published_date || fallback.publishedDate,
		summary: article.summary ?? fallback.summary,
		sourceType: article.source_type || fallback.sourceType,
		content: article.content ?? fallback.content,
		platformMetadata: article.platform_metadata ?? fallback.platformMetadata,
		tags: article.tags?.length ? article.tags : fallback.tags,
		keywords: article.keywords?.length ? article.keywords : fallback.keywords,
	};
}

async function stageSavedUrlAcquisition(env: CoreEnv, step: WorkflowStep, article: Article): Promise<AcquiredContent | null> {
	const artifact = await step.do(
		'acquire-content',
		{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
		() => scrapeSavedUrlArtifact(article.url, env),
	);
	return readAcquiredContentArtifact(artifact);
}

async function stageOgImagePatch(step: WorkflowStep, article: Article, acquiredContent: AcquiredContent | null): Promise<OgImagePatch> {
	if (article.og_image_url || !article.url || article.file_type === PDF_MIME) return EMPTY_OG_IMAGE_PATCH;
	if (acquiredContent?.ogImage?.ogImageUrl) return acquiredContent.ogImage;
	return step.do('resolve-og-image', { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '30 seconds' }, () =>
		fetchOgImage(article.url),
	);
}

async function loadFullTargetArticle(
	env: CoreEnv,
	target: WorkflowTarget,
	pdfTextArtifact: PdfTextArtifact | null,
	acquiredContent: AcquiredContent | null = null,
	baseArticle?: Article,
): Promise<Article> {
	let article: Article;
	if (baseArticle) {
		article = baseArticle;
	} else if (target.kind === 'source') {
		article = sourceRecordToArticle(target.draft.article);
	} else {
		article = await loadArticleForProcessing(env, storedTargetTable(target), target.rowId);
	}
	article = applyAcquiredContent(article, acquiredContent);
	const extractedPdfText = pdfTextArtifact?.text?.trim() || null;
	return extractedPdfText === null ? article : { ...article, content: extractedPdfText };
}

async function persistSourceWorkflowTarget(
	coreDb: CoreDb,
	target: SourceWorkflowTarget,
	article: Article,
	result: ProcessorResult,
	embedding: number[] | null,
	acquiredContent: AcquiredContent | null,
	paperEnrichment: PaperMetadata | null,
	ogPayload: Record<string, unknown>,
): Promise<PersistedTargetIds> {
	const acquiredPayload = acquiredContentUpdatePayload(acquiredContent);
	const updatePayload = buildProcessorUpdatePayload(
		article,
		result,
		embedding,
		mergeMetadataPatch(acquiredPayload.platform_metadata, ogPayload.platform_metadata, paperMetadataPatch(paperEnrichment)),
	);
	Object.assign(updatePayload, withoutPlatformMetadata(acquiredPayload), withoutPlatformMetadata(ogPayload));

	const platformMetadata = updatePayload.platform_metadata ?? article.platform_metadata;
	const entities = normalizeArticleEntityUpdatePayload(updatePayload, article.source, platformMetadata);
	const legacyId = await insertFinalSourceArticle(coreDb, sourceArticleBase(article, target.draft.article), updatePayload);
	const resourceId = await syncResourceAfterProcessing(coreDb, 'articles', legacyId, article, updatePayload);
	if (entities) {
		await syncArticleEntities(coreDb, legacyId, entities, article.source, platformMetadata);
		await syncResourceEntities(coreDb, resourceId, entities, article.source, platformMetadata);
	}
	return { legacyId, resourceId };
}

async function persistStoredWorkflowTarget(
	coreDb: CoreDb,
	target: StoredWorkflowTarget,
	article: Article,
	result: ProcessorResult,
	embedding: number[] | null,
	pdfTextArtifact: PdfTextArtifact | null,
	acquiredContent: AcquiredContent | null,
	paperEnrichment: PaperMetadata | null,
	ogPayload: Record<string, unknown>,
): Promise<PersistedTargetIds> {
	const finalResult =
		pdfTextArtifact?.text && article.content ? { ...result, updateData: { ...result.updateData, content: article.content } } : result;
	const extraction = pdfTextArtifact ? pdfExtractionMetadata(pdfTextArtifact) : acquiredContent?.extraction;
	const metadataPatch = mergeMetadataPatch(
		extraction ? { extraction } : undefined,
		ogPayload.platform_metadata,
		paperMetadataPatch(paperEnrichment),
	);
	const updatePayload = {
		...withoutPlatformMetadata(
			acquiredContentUpdatePayload(acquiredContent, { preserveSourceType: target.kind === 'article' && target.reacquire }),
		),
		...buildProcessorUpdatePayload(article, finalResult, embedding, metadataPatch),
		...withoutPlatformMetadata(ogPayload),
	};
	const platformMetadata = updatePayload.platform_metadata ?? article.platform_metadata;
	const entities = normalizeArticleEntityUpdatePayload(updatePayload, article.source, platformMetadata);
	const table = storedTargetTable(target);

	await updateArticleAfterProcessing(coreDb, table, target.rowId, updatePayload);
	const resourceId = await syncResourceAfterProcessing(coreDb, table, target.rowId, article, updatePayload);
	if (entities) {
		if (table === 'articles') await syncArticleEntities(coreDb, target.rowId, entities, article.source, platformMetadata);
		await syncResourceEntities(coreDb, resourceId, entities, article.source, platformMetadata);
	}
	return { legacyId: target.rowId, resourceId };
}

async function persistWorkflowTarget(
	env: CoreEnv,
	target: WorkflowTarget,
	article: Article,
	result: ProcessorResult,
	embedding: number[] | null,
	pdfTextArtifact: PdfTextArtifact | null,
	acquiredContent: AcquiredContent | null,
	paperEnrichment: PaperMetadata | null,
	ogImagePatch: OgImagePatch,
	youtubeTranscript: YoutubeTranscript | undefined,
	youtubeHighlights: Awaited<ReturnType<typeof prepareYouTubeHighlights>>,
): Promise<PersistedTargetIds> {
	return withCoreTx(env, async (coreDb, _db) => {
		const ogPayload = ogImageUpdatePayload(ogImagePatch);
		const persisted =
			target.kind === 'source'
				? await persistSourceWorkflowTarget(coreDb, target, article, result, embedding, acquiredContent, paperEnrichment, ogPayload)
				: await persistStoredWorkflowTarget(
						coreDb,
						target,
						article,
						result,
						embedding,
						pdfTextArtifact,
						acquiredContent,
						paperEnrichment,
						ogPayload,
					);
		if (youtubeTranscript || youtubeHighlights)
			await persistYouTubeWorkflowData(coreDb, { transcript: youtubeTranscript, highlights: youtubeHighlights });
		return persisted;
	});
}

export class NewsenceMonitorWorkflow extends WorkflowEntrypoint<CoreEnv, { target: WorkflowTarget }> {
	async run(event: WorkflowEvent<{ target: WorkflowTarget }>, step: WorkflowStep) {
		const target = event.payload.target;
		const initialArticle = await step.do(
			target.kind === 'source' ? 'load-source-article-shell' : 'fetch-article-shell',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => {
				if (target.kind === 'source') return { ...sourceRecordToArticle(target.draft.article), content: null };
				return loadArticleForProcessing(this.env, storedTargetTable(target), target.rowId, true);
			},
		);
		const acquiredContent = shouldAcquireContent(target, initialArticle)
			? await stageSavedUrlAcquisition(this.env, step, initialArticle)
			: null;
		const article = applyAcquiredContent(initialArticle, acquiredContent);
		const metadataType = article.platform_metadata?.type;
		const sourceType =
			metadataType && metadataType !== 'pdf' && metadataType !== 'paper' ? metadataType : (article.source_type ?? 'default');
		const logContext =
			target.kind === 'source' ? { url: article.url, table: 'articles' } : { article_id: target.rowId, table: storedTargetTable(target) };

		console.info({ tag: 'WORKFLOW', msg: 'Starting', sourceType, ...logContext });

		const hasContent = 'has_content' in article && !!article.has_content;
		const pdfTextArtifact =
			target.kind === 'userFile' && !hasContent && article.storage_key && article.file_type === PDF_MIME
				? await stagePdfTextExtraction(this.env, step, {
						sourceStorageKey: article.storage_key,
					})
				: null;

		const paperEnrichment = await stagePaperEnrichment(this.env, step, article, {
			hasStagedText: !!pdfTextArtifact?.text,
			loadContent: async () =>
				(await loadFullTargetArticle(this.env, target, pdfTextArtifact, acquiredContent, acquiredContent ? article : undefined)).content,
		});
		const ogImagePatch = await stageOgImagePatch(step, article, acquiredContent);

		const processorResult = await step.do(
			'ai-analysis',
			{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '600 seconds' },
			async () => {
				const fullArticle = await loadFullTargetArticle(
					this.env,
					target,
					pdfTextArtifact,
					acquiredContent,
					acquiredContent ? article : undefined,
				);
				if (sourceType === 'hackernews') return processHackerNewsArticle(fullArticle, this.env);
				if (sourceType === 'twitter') return processTwitterArticle(fullArticle, this.env);
				return mergeArticleAnalysis(fullArticle, await generateArticleAnalysis(fullArticle, this.env));
			},
		);

		const embedding = await step.do(
			'generate-embedding',
			{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
			async () => {
				const fullArticle = await loadFullTargetArticle(
					this.env,
					target,
					pdfTextArtifact,
					acquiredContent,
					acquiredContent ? article : undefined,
				);
				const text = prepareArticleTextForEmbedding({
					title: fullArticle.title,
					summary: processorResult.updateData.summary ?? fullArticle.summary,
					content: processorResult.updateData.content ?? fullArticle.content,
					tags: processorResult.updateData.tags ?? fullArticle.tags,
					keywords: processorResult.updateData.keywords ?? fullArticle.keywords,
				});
				return text && this.env.AI ? generateArticleEmbedding(text, this.env.AI, this.env.AI_GATEWAY_NAME) : null;
			},
		);

		const youtubeTranscript =
			sourceType === 'youtube'
				? target.kind === 'source'
					? target.draft.youtubeTranscript
					: acquiredContent?.youtubeTranscript
				: undefined;
		const youtubeHighlights =
			sourceType === 'youtube'
				? await step.do(
						'prepare-youtube-highlights',
						{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
						async () => prepareYouTubeHighlights(this.env, article, youtubeTranscript),
					)
				: null;
		const persisted = await step.do(
			target.kind === 'source' ? 'insert-final-article' : 'update-db',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () =>
				persistWorkflowTarget(
					this.env,
					target,
					target.kind === 'source' || pdfTextArtifact?.text || acquiredContent
						? await loadFullTargetArticle(this.env, target, pdfTextArtifact, acquiredContent, acquiredContent ? article : undefined)
						: article,
					processorResult,
					embedding,
					pdfTextArtifact,
					acquiredContent,
					paperEnrichment,
					ogImagePatch,
					youtubeTranscript,
					youtubeHighlights,
				),
		);

		await syncPaperGraphForEnrichment(this.env, step, persisted.resourceId, paperEnrichment);

		console.info({ tag: 'WORKFLOW', msg: 'Completed', article_id: persisted.legacyId, resource_id: persisted.resourceId, ...logContext });
		return { success: true, article_id: persisted.legacyId, resource_id: persisted.resourceId };
	}
}
