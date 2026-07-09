import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { generateArticleEmbedding, prepareArticleTextForEmbedding } from '@core-ai/embedding';
import type { PaperMetadata, ResourceForProcessing, YoutubeTranscript } from '@core-shared/types';
import { type CoreDb, withCoreTx } from '@db/client';
import { normalizeResourceEntityUpdatePayload } from '@entities/normalize';
import { loadResourceForProcessing, syncResourceEntities, updateResourceAfterProcessing } from '@ingest/domain/resource-store';
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

function shouldAcquireContent(resource: ResourceForProcessing): boolean {
	const hasContent = 'has_content' in resource && !!resource.has_content;
	return !hasContent && !resource.storage_key && !!resource.url;
}

async function stageSavedUrlAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	resource: ResourceForProcessing,
): Promise<AcquiredContent | null> {
	const artifact = await step.do(
		'acquire-content',
		{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
		() => scrapeSavedUrlArtifact(resource.url, env),
	);
	return readAcquiredContentArtifact(artifact);
}

async function stageOgImagePatch(
	step: WorkflowStep,
	resource: ResourceForProcessing,
	acquiredContent: AcquiredContent | null,
): Promise<OgImagePatch> {
	if (resource.og_image_url || !resource.url || resource.file_type === PDF_MIME) return EMPTY_OG_IMAGE_PATCH;
	if (acquiredContent?.ogImage?.ogImageUrl) return acquiredContent.ogImage;
	return step.do('resolve-og-image', { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '30 seconds' }, () =>
		fetchOgImage(resource.url),
	);
}

async function loadFullTargetResource(
	env: CoreEnv,
	target: WorkflowTarget,
	pdfTextArtifact: PdfTextArtifact | null,
	acquiredContent: AcquiredContent | null = null,
	baseResource?: ResourceForProcessing,
): Promise<ResourceForProcessing> {
	let resource: ResourceForProcessing;
	if (baseResource) {
		resource = baseResource;
	} else {
		resource = await loadResourceForProcessing(env, target.rowId);
	}
	resource = applyAcquiredContent(resource, acquiredContent);
	const extractedPdfText = pdfTextArtifact?.text?.trim() || null;
	return extractedPdfText === null ? resource : { ...resource, content: extractedPdfText };
}

async function persistStoredWorkflowTarget(
	coreDb: CoreDb,
	target: WorkflowTarget,
	resource: ResourceForProcessing,
	result: ProcessorResult,
	embedding: number[] | null,
	pdfTextArtifact: PdfTextArtifact | null,
	acquiredContent: AcquiredContent | null,
	paperEnrichment: PaperMetadata | null,
	ogImagePatch: OgImagePatch,
): Promise<PersistedTargetIds> {
	const finalResult =
		pdfTextArtifact?.text && resource.content ? { ...result, updateData: { ...result.updateData, content: resource.content } } : result;
	const extraction = pdfTextArtifact ? pdfExtractionMetadata(pdfTextArtifact) : acquiredContent?.extraction;
	const updatePayload = new ResourceUpdateBuilder(resource)
		.addExtractionMetadata(extraction)
		.addOgMetadata(ogImagePatch)
		.addPaperMetadata(paperEnrichment)
		.applyAcquiredFields(acquiredContent)
		.applyProcessorResult(finalResult, embedding)
		.applyOgFields(ogImagePatch)
		.build();
	const platformMetadata = updatePayload.platform_metadata ?? resource.platform_metadata;
	const entities = normalizeResourceEntityUpdatePayload(updatePayload, resource.source, platformMetadata);
	const resourceId = await updateResourceAfterProcessing(coreDb, target.rowId, resource, updatePayload);
	if (entities) {
		await syncResourceEntities(coreDb, resourceId, entities, resource.source, platformMetadata);
	}
	return { resourceId };
}

async function persistWorkflowTarget(
	env: CoreEnv,
	target: WorkflowTarget,
	resource: ResourceForProcessing,
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
			resource,
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
		const initialResource = await step.do(
			'fetch-resource-shell',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => loadResourceForProcessing(this.env, target.rowId, true),
		);
		const acquiredContent = shouldAcquireContent(initialResource) ? await stageSavedUrlAcquisition(this.env, step, initialResource) : null;
		const resource = applyAcquiredContent(initialResource, acquiredContent);
		const resourceType = resource.type;
		const logContext = { resource_id: target.rowId, table: 'resources' };

		console.info({ tag: 'WORKFLOW', msg: 'Starting', resourceType, ...logContext });

		const hasContent = 'has_content' in resource && !!resource.has_content;
		const pdfTextArtifact =
			!hasContent && resource.storage_key && resource.file_type === PDF_MIME
				? await stagePdfTextExtraction(this.env, step, {
						sourceStorageKey: resource.storage_key,
					})
				: null;

		const paperEnrichment = await stagePaperEnrichment(this.env, step, resource, {
			hasStagedText: !!pdfTextArtifact?.text,
			loadContent: async () =>
				(await loadFullTargetResource(this.env, target, pdfTextArtifact, acquiredContent, acquiredContent ? resource : undefined)).content,
		});
		const ogImagePatch = await stageOgImagePatch(step, resource, acquiredContent);

		const processorResult = await step.do(
			'ai-analysis',
			{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '600 seconds' },
			async () => {
				const fullResource = await loadFullTargetResource(
					this.env,
					target,
					pdfTextArtifact,
					acquiredContent,
					acquiredContent ? resource : undefined,
				);
				if (resourceType === 'hackernews') return processHackerNewsArticle(fullResource, this.env);
				if (resourceType === 'twitter') return processTwitterArticle(fullResource, this.env);
				return mergeArticleAnalysis(fullResource, await generateArticleAnalysis(fullResource, this.env));
			},
		);

		const embedding = await step.do(
			'generate-embedding',
			{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
			async () => {
				const fullResource = await loadFullTargetResource(
					this.env,
					target,
					pdfTextArtifact,
					acquiredContent,
					acquiredContent ? resource : undefined,
				);
				const text = prepareArticleTextForEmbedding({
					title: fullResource.title,
					summary: processorResult.updateData.summary ?? fullResource.summary,
					content: processorResult.updateData.content ?? fullResource.content,
					tags: processorResult.updateData.tags ?? fullResource.tags,
					keywords: processorResult.updateData.keywords ?? fullResource.keywords,
				});
				return text && this.env.AI ? generateArticleEmbedding(text, this.env.AI, this.env.AI_GATEWAY_NAME) : null;
			},
		);

		const youtubeTranscript = resourceType === 'youtube' ? acquiredContent?.youtubeTranscript : undefined;
		const youtubeHighlights =
			resourceType === 'youtube'
				? await step.do(
						'prepare-youtube-highlights',
						{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
						async () => prepareYouTubeHighlights(this.env, resource, youtubeTranscript),
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
						? await loadFullTargetResource(this.env, target, pdfTextArtifact, acquiredContent, acquiredContent ? resource : undefined)
						: resource,
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
