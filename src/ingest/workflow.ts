import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { generateArticleEmbedding, prepareArticleTextForEmbedding } from '@core-ai/embedding';
import type { Article, PaperMetadata, YoutubeTranscript } from '@core-shared/types';
import { type CoreDb, withCoreTx } from '@db/client';
import { normalizeArticleEntityUpdatePayload } from '@entities/normalize';
import { loadResourceForProcessing, syncResourceEntities, updateResourceAfterProcessing } from '@ingest/domain/article-store';
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
import { applyAcquiredContent, ResourceUpdateBuilder } from './domain/resource-update';
import { processHackerNewsArticle } from './platforms/hackernews';
import { stagePaperEnrichment, syncPaperGraphForEnrichment } from './platforms/paper';
import { type PdfTextArtifact, stagePdfTextExtraction } from './platforms/pdf';
import { processTwitterArticle } from './platforms/twitter';
import { persistYouTubeWorkflowData, prepareYouTubeHighlights } from './platforms/youtube';

type WorkflowTarget = { kind: 'resource'; rowId: string };
type PersistedTargetIds = { resourceId: string };

const ACTIVE_WORKFLOW_STATUSES = new Set(['queued', 'running', 'paused', 'waiting', 'waitingForPause']);

export async function enqueueProcessing(env: CoreEnv, target: WorkflowTarget): Promise<string> {
	const workflowId = storedWorkflowId(target);
	const [created] = await env.MONITOR_WORKFLOW.createBatch([{ id: workflowId, params: { target } }]);
	if (created) return created.id;

	const instance = await env.MONITOR_WORKFLOW.get(workflowId);
	const { status } = await instance.status();
	if (ACTIVE_WORKFLOW_STATUSES.has(status)) return instance.id;

	await instance.restart();
	return instance.id;
}

function workflowIdPart(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
}

function storedWorkflowId(target: WorkflowTarget): string {
	return ['resource', workflowIdPart(target.rowId)].join('-');
}

function shouldAcquireContent(article: Article): boolean {
	const hasContent = 'has_content' in article && !!article.has_content;
	return !hasContent && !article.storage_key && !!article.url;
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
	} else {
		article = await loadResourceForProcessing(env, target.rowId);
	}
	article = applyAcquiredContent(article, acquiredContent);
	const extractedPdfText = pdfTextArtifact?.text?.trim() || null;
	return extractedPdfText === null ? article : { ...article, content: extractedPdfText };
}

async function persistStoredWorkflowTarget(
	coreDb: CoreDb,
	target: WorkflowTarget,
	article: Article,
	result: ProcessorResult,
	embedding: number[] | null,
	pdfTextArtifact: PdfTextArtifact | null,
	acquiredContent: AcquiredContent | null,
	paperEnrichment: PaperMetadata | null,
	ogImagePatch: OgImagePatch,
): Promise<PersistedTargetIds> {
	const finalResult =
		pdfTextArtifact?.text && article.content ? { ...result, updateData: { ...result.updateData, content: article.content } } : result;
	const extraction = pdfTextArtifact ? pdfExtractionMetadata(pdfTextArtifact) : acquiredContent?.extraction;
	const updatePayload = new ResourceUpdateBuilder(article)
		.addExtractionMetadata(extraction)
		.addOgMetadata(ogImagePatch)
		.addPaperMetadata(paperEnrichment)
		.applyAcquiredFields(acquiredContent)
		.applyProcessorResult(finalResult, embedding)
		.applyOgFields(ogImagePatch)
		.build();
	const platformMetadata = updatePayload.platform_metadata ?? article.platform_metadata;
	const entities = normalizeArticleEntityUpdatePayload(updatePayload, article.source, platformMetadata);
	const resourceId = await updateResourceAfterProcessing(coreDb, target.rowId, article, updatePayload);
	if (entities) {
		await syncResourceEntities(coreDb, resourceId, entities, article.source, platformMetadata);
	}
	return { resourceId };
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
		const persisted = await persistStoredWorkflowTarget(
			coreDb,
			target,
			article,
			result,
			embedding,
			pdfTextArtifact,
			acquiredContent,
			paperEnrichment,
			ogImagePatch,
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
			'fetch-article-shell',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => loadResourceForProcessing(this.env, target.rowId, true),
		);
		const acquiredContent = shouldAcquireContent(initialArticle) ? await stageSavedUrlAcquisition(this.env, step, initialArticle) : null;
		const article = applyAcquiredContent(initialArticle, acquiredContent);
		const metadataType = article.platform_metadata?.type;
		const sourceType =
			metadataType && metadataType !== 'pdf' && metadataType !== 'paper' ? metadataType : (article.source_type ?? 'default');
		const logContext = { resource_id: target.rowId, table: 'resources' };

		console.info({ tag: 'WORKFLOW', msg: 'Starting', sourceType, ...logContext });

		const hasContent = 'has_content' in article && !!article.has_content;
		const pdfTextArtifact =
			!hasContent && article.storage_key && article.file_type === PDF_MIME
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

		const youtubeTranscript = sourceType === 'youtube' ? acquiredContent?.youtubeTranscript : undefined;
		const youtubeHighlights =
			sourceType === 'youtube'
				? await step.do(
						'prepare-youtube-highlights',
						{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
						async () => prepareYouTubeHighlights(this.env, article, youtubeTranscript),
					)
				: null;
		const persisted = await step.do(
			'update-db',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () =>
				persistWorkflowTarget(
					this.env,
					target,
					pdfTextArtifact?.text || acquiredContent
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

		console.info({ tag: 'WORKFLOW', msg: 'Completed', resource_id: persisted.resourceId, table: 'resources' });
		return { success: true, resource_id: persisted.resourceId };
	}
}
