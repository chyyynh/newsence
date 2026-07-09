import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { generateResourceEmbedding, prepareResourceTextForEmbedding } from '@core-ai/embedding';
import type { ResourceForProcessing } from '@core-shared/types';
import {
	claimResourcesForEnrichmentRecovery,
	loadResourceForProcessing,
	markResourceEnrichmentFailed,
} from '@ingest/domain/resource-store';
import {
	type AcquiredContent,
	EMPTY_OG_IMAGE_PATCH,
	fetchOgImage,
	type OgImagePatch,
	PDF_MIME,
	readAcquiredContentArtifact,
	scrapeSavedUrlArtifact,
} from './acquisition';
import { generateResourceAnalysis, mergeResourceAnalysis } from './domain/ai-utils';
import { applyAcquiredContent } from './domain/resource-update';
import { processHackerNewsResource } from './platforms/hackernews';
import { stagePaperEnrichment, syncPaperGraphForEnrichment } from './platforms/paper';
import { type PdfTextArtifact, stagePdfTextExtraction } from './platforms/pdf';
import { processTwitterResource } from './platforms/twitter';
import { prepareYouTubeHighlights } from './platforms/youtube';
import { persistProcessedResource } from './resource-persistence';

type WorkflowPayload = { resourceId: string };

const ACTIVE_WORKFLOW_STATUSES = new Set(['queued', 'running', 'paused', 'waiting', 'waitingForPause']);

export async function enqueueProcessing(env: CoreEnv, resourceId: string): Promise<string> {
	const workflowId = storedWorkflowId(resourceId);
	const [created] = await env.MONITOR_WORKFLOW.createBatch([{ id: workflowId, params: { resourceId } }]);
	if (created) return created.id;

	const instance = await env.MONITOR_WORKFLOW.get(workflowId);
	const { status } = await instance.status();
	if (ACTIVE_WORKFLOW_STATUSES.has(status)) return instance.id;

	await instance.restart();
	return instance.id;
}

export async function recoverStalledResourceProcessing(env: CoreEnv): Promise<void> {
	const resourceIds = await claimResourcesForEnrichmentRecovery(env);
	let queued = 0;
	let failed = 0;

	for (let index = 0; index < resourceIds.length; index += 10) {
		const batch = resourceIds.slice(index, index + 10);
		const results = await Promise.allSettled(batch.map((resourceId) => enqueueProcessing(env, resourceId)));
		for (const [resultIndex, result] of results.entries()) {
			if (result.status === 'fulfilled') {
				queued++;
				continue;
			}

			failed++;
			const resourceId = batch[resultIndex]!;
			console.error({ tag: 'RECOVERY', msg: 'Resource re-enqueue failed', resource_id: resourceId, error: String(result.reason) });
			await markResourceEnrichmentFailed(env, resourceId).catch((error) =>
				console.error({ tag: 'RECOVERY', msg: 'Failed to restore failed status', resource_id: resourceId, error: String(error) }),
			);
		}
	}

	if (resourceIds.length) console.info({ tag: 'RECOVERY', msg: 'Sweep completed', claimed: resourceIds.length, queued, failed });
}

function workflowIdPart(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
}

function storedWorkflowId(resourceId: string): string {
	return ['resource', workflowIdPart(resourceId)].join('-');
}

function shouldAcquireContent(resource: ResourceForProcessing & { has_content?: boolean; has_youtube_transcript?: boolean }): boolean {
	const hasContent = 'has_content' in resource && !!resource.has_content;
	const needsYouTubeAcquisition = resource.type === 'youtube' && !resource.has_youtube_transcript;
	return (!hasContent || needsYouTubeAcquisition) && !resource.storage_key && !!resource.url;
}

async function stageSavedUrlAcquisition(env: CoreEnv, step: WorkflowStep, resource: ResourceForProcessing): Promise<AcquiredContent> {
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
	acquiredContent?: AcquiredContent,
): Promise<OgImagePatch> {
	if (resource.og_image_url || !resource.url || resource.file_type === PDF_MIME) return EMPTY_OG_IMAGE_PATCH;
	if (acquiredContent?.ogImage?.ogImageUrl) return acquiredContent.ogImage;
	return step.do('resolve-og-image', { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '30 seconds' }, () =>
		fetchOgImage(resource.url),
	);
}

async function loadFullResource(
	env: CoreEnv,
	resourceId: string,
	pdfTextArtifact: PdfTextArtifact | null,
	acquiredContent?: AcquiredContent,
	baseResource?: ResourceForProcessing,
): Promise<ResourceForProcessing> {
	let resource: ResourceForProcessing;
	if (baseResource) {
		resource = baseResource;
	} else {
		resource = await loadResourceForProcessing(env, resourceId);
	}
	resource = applyAcquiredContent(resource, acquiredContent);
	const extractedPdfText = pdfTextArtifact?.text?.trim();
	return extractedPdfText ? { ...resource, content: extractedPdfText } : resource;
}

export class NewsenceMonitorWorkflow extends WorkflowEntrypoint<CoreEnv, WorkflowPayload> {
	async run(event: WorkflowEvent<WorkflowPayload>, step: WorkflowStep) {
		const { resourceId } = event.payload;
		try {
			return await this.runResource(resourceId, step);
		} catch (error) {
			await step
				.do('mark-resource-failed', { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' }, () =>
					markResourceEnrichmentFailed(this.env, resourceId),
				)
				.catch((markError) =>
					console.error({
						tag: 'WORKFLOW',
						msg: 'Failed to mark resource enrichment as failed',
						resource_id: resourceId,
						error: String(markError),
					}),
				);
			throw error;
		}
	}

	private async runResource(resourceId: string, step: WorkflowStep) {
		const initialResource = await step.do(
			'fetch-resource-shell',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => loadResourceForProcessing(this.env, resourceId, true),
		);
		const acquiredContent = shouldAcquireContent(initialResource)
			? await stageSavedUrlAcquisition(this.env, step, initialResource)
			: undefined;
		const resource = applyAcquiredContent(initialResource, acquiredContent);
		const resourceType = resource.type;
		const logContext = { resource_id: resourceId, table: 'resources' };

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
				(await loadFullResource(this.env, resourceId, pdfTextArtifact, acquiredContent, acquiredContent ? resource : undefined)).content,
		});
		const ogImagePatch = await stageOgImagePatch(step, resource, acquiredContent);

		const processorResult = await step.do(
			'ai-analysis',
			{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '600 seconds' },
			async () => {
				const fullResource = await loadFullResource(
					this.env,
					resourceId,
					pdfTextArtifact,
					acquiredContent,
					acquiredContent ? resource : undefined,
				);
				if (resourceType === 'hackernews') return processHackerNewsResource(fullResource, this.env);
				if (resourceType === 'twitter') return processTwitterResource(fullResource, this.env);
				return mergeResourceAnalysis(fullResource, await generateResourceAnalysis(fullResource, this.env));
			},
		);

		const embedding = await step.do(
			'generate-embedding',
			{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
			async () => {
				const fullResource = await loadFullResource(
					this.env,
					resourceId,
					pdfTextArtifact,
					acquiredContent,
					acquiredContent ? resource : undefined,
				);
				const text = prepareResourceTextForEmbedding({
					title: fullResource.title,
					summary: processorResult.updateData.summary ?? fullResource.summary,
					content: processorResult.updateData.content ?? fullResource.content,
					tags: processorResult.updateData.tags ?? fullResource.tags,
					keywords: processorResult.updateData.keywords ?? fullResource.keywords,
				});
				if (!text) throw new Error(`Resource ${resourceId} has no text to embed`);
				const generated = await generateResourceEmbedding(text, this.env.AI, this.env.AI_GATEWAY_NAME);
				if (!generated?.length) throw new Error(`Embedding generation failed for resource ${resourceId}`);
				return generated;
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
		const persistedResourceId = await step.do(
			'update-db',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => {
				const resourceToPersist =
					pdfTextArtifact?.text || acquiredContent
						? await loadFullResource(this.env, resourceId, pdfTextArtifact, acquiredContent, acquiredContent ? resource : undefined)
						: resource;
				return persistProcessedResource(this.env, {
					resourceId,
					resource: resourceToPersist,
					processorResult,
					embedding,
					pdfTextArtifact,
					acquisitionExtraction: acquiredContent?.extraction,
					paperEnrichment,
					ogImagePatch,
					youtubeTranscript,
					youtubeHighlights,
				});
			},
		);

		await syncPaperGraphForEnrichment(this.env, step, persistedResourceId, paperEnrichment);

		console.info({ tag: 'WORKFLOW', msg: 'Completed', resource_id: persistedResourceId, table: 'resources' });
		return { success: true, resource_id: persistedResourceId };
	}
}
