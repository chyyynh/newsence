import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { ResourceForProcessing } from '@core-shared/types';
import { loadResourceForProcessing } from '@ingest/domain/resource-store';
import { deleteCorpusItem, syncCorpusItem } from '../ai-search';
import { enqueueOrRestartWorkflow } from '../workflow-control';
import {
	type AcquiredContent,
	acquisitionHttpStatus,
	EMPTY_OG_IMAGE_PATCH,
	fetchOgImage,
	type OgImagePatch,
	PDF_MIME,
	readAcquiredContentArtifact,
	scrapeSavedUrlArtifact,
} from './acquisition';
import { enqueueResourceTranslation, getPersistedResourceContentHashForTranslation } from './content-localization-workflow';
import { generateResourceClassification, mergeResourceClassification } from './domain/ai-utils';
import { applyAcquiredContent } from './domain/resource-update';
import { generateHackerNewsEnrichments } from './platforms/hackernews';
import { stagePaperEnrichment } from './platforms/paper';
import { stagePdfTextExtraction } from './platforms/pdf';
import { prepareTwitterClassification } from './platforms/twitter';
import { prepareYouTubeHighlights } from './platforms/youtube';
import {
	markResourceEnrichmentFailed,
	persistProcessedResource,
	persistUnchangedResourceResync,
	settleForbiddenResource,
} from './resource-persistence';

type WorkflowOperation = 'ingest' | 'resync';
type WorkflowPayload = { resourceId: string; operation?: WorkflowOperation };

export function enqueueProcessing(env: CoreEnv, resourceId: string): Promise<string> {
	return enqueueOrRestartWorkflow(env.RESOURCE_PROCESSING_WORKFLOW, storedWorkflowId(resourceId), { resourceId });
}

export function enqueueResourceResync(env: CoreEnv, resourceId: string): Promise<string> {
	return enqueueOrRestartWorkflow(env.RESOURCE_PROCESSING_WORKFLOW, `resource-resync-${workflowIdPart(resourceId)}`, {
		resourceId,
		operation: 'resync',
	});
}

function workflowIdPart(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
}

function storedWorkflowId(resourceId: string): string {
	return ['resource', workflowIdPart(resourceId)].join('-');
}

function shouldAcquireContent(
	resource: ResourceForProcessing & { has_content?: boolean; has_youtube_transcript?: boolean },
	force = false,
): boolean {
	if (force) return !!resource.url;
	const hasContent = 'has_content' in resource && !!resource.has_content;
	const needsYouTubeAcquisition = resource.type === 'youtube' && !resource.has_youtube_transcript;
	return (!hasContent || needsYouTubeAcquisition) && !resource.storage_key && !!resource.url;
}

async function stageSavedUrlAcquisition(env: CoreEnv, step: WorkflowStep, resource: ResourceForProcessing): Promise<AcquiredContent> {
	const artifact = await step.do(
		'acquire-content',
		{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
		async () => {
			try {
				return await scrapeSavedUrlArtifact(resource.url, env);
			} catch (error) {
				if (acquisitionHttpStatus(error) !== 403) throw error;
				throw new NonRetryableError(error instanceof Error ? error.message : String(error), 'AcquisitionForbiddenError');
			}
		},
	);
	return readAcquiredContentArtifact(artifact);
}

type AcquisitionTerminalResult = {
	resourceId: string;
	deleted: boolean;
	reason: 'acquisition_http_403';
};

async function settleResourceAfterForbiddenAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	resource: ResourceForProcessing,
	error: unknown,
): Promise<AcquisitionTerminalResult> {
	const deleted = await step.do(
		'delete-forbidden-resource',
		{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
		() => settleForbiddenResource(env, resource.id),
	);
	console.info({
		tag: 'WORKFLOW',
		msg: deleted ? 'Deleted unreferenced resource after forbidden acquisition' : 'Retained referenced resource after forbidden acquisition',
		resource_id: resource.id,
		url: resource.url,
		deleted,
		error: String(error),
	});
	return { resourceId: resource.id, deleted, reason: 'acquisition_http_403' };
}

async function acquireResourceForOperation(
	env: CoreEnv,
	step: WorkflowStep,
	resource: ResourceForProcessing,
	operation: WorkflowOperation,
): Promise<{ acquiredContent?: AcquiredContent } | { terminal: AcquisitionTerminalResult }> {
	if (!shouldAcquireContent(resource, operation === 'resync')) return {};

	let acquiredContent: AcquiredContent | undefined;
	try {
		acquiredContent = await stageSavedUrlAcquisition(env, step, resource);
	} catch (error) {
		if (operation === 'resync' || acquisitionHttpStatus(error) !== 403) throw error;
		return {
			terminal: await settleResourceAfterForbiddenAcquisition(env, step, resource, error),
		};
	}
	return { acquiredContent };
}

async function stageOgImagePatch(
	step: WorkflowStep,
	resource: ResourceForProcessing,
	acquiredContent?: AcquiredContent,
	force = false,
): Promise<OgImagePatch> {
	if (acquiredContent?.ogImage?.ogImageUrl) return acquiredContent.ogImage;
	if ((!force && resource.og_image_url) || !resource.url || resource.file_type === PDF_MIME || resource.type === 'hackernews') {
		return EMPTY_OG_IMAGE_PATCH;
	}
	return step.do('resolve-og-image', { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '30 seconds' }, () =>
		fetchOgImage(resource.url),
	);
}

export class ResourceProcessingWorkflow extends WorkflowEntrypoint<CoreEnv, WorkflowPayload> {
	async run(event: WorkflowEvent<WorkflowPayload>, step: WorkflowStep) {
		const { resourceId } = event.payload;
		const operation = event.payload.operation ?? 'ingest';
		try {
			return await this.runResource(resourceId, step, operation);
		} catch (error) {
			if (operation === 'resync') throw error;
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
			await step
				.do(
					'remove-failed-resource-from-search-index',
					{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
					() => deleteCorpusItem(this.env, resourceId),
				)
				.catch((indexError) =>
					console.error({
						tag: 'AI_SEARCH',
						msg: 'Failed to remove failed resource from search index',
						resource_id: resourceId,
						error: String(indexError),
					}),
				);
			throw error;
		}
	}

	private async runResource(resourceId: string, step: WorkflowStep, operation: WorkflowOperation) {
		const initialResource = await step.do(
			'fetch-resource-shell',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => loadResourceForProcessing(this.env, resourceId, true),
		);
		if (operation === 'resync' && !initialResource.url) {
			throw new NonRetryableError(`Resource ${resourceId} has no source URL`, 'ResourceResyncUnsupportedError');
		}
		const acquisition = await acquireResourceForOperation(this.env, step, initialResource, operation);
		if ('terminal' in acquisition) return acquisition.terminal;
		const { acquiredContent } = acquisition;
		const previousSnapshotHash = initialResource.platform_metadata?.sourceSnapshotHash;
		const nextSnapshotHash = acquiredContent?.platformMetadata?.sourceSnapshotHash;
		if (operation === 'resync' && previousSnapshotHash && previousSnapshotHash === nextSnapshotHash && acquiredContent) {
			await step.do(
				'record-unchanged-resync',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() => persistUnchangedResourceResync(this.env, resourceId, acquiredContent),
			);
			return { success: true, resource_id: resourceId, operation, changed: false };
		}
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
		const pdfExtraction = pdfTextArtifact ?? acquiredContent?.extraction;
		if (resourceType === 'pdf' && pdfExtraction?.status === 'needs_ocr') {
			throw new NonRetryableError(`PDF resource ${resourceId} requires OCR`, 'PdfOcrRequiredError');
		}
		const hasProcessableContent = hasContent || !!pdfTextArtifact?.text?.trim() || !!acquiredContent?.markdown?.trim();
		if (!hasProcessableContent) {
			throw new NonRetryableError(`Resource ${resourceId} has no extractable content`, 'ResourceContentMissingError');
		}

		// Reread durable rows unless in-memory acquisition already holds the freshest copy; PDF text always wins.
		const loadFull = async (): Promise<ResourceForProcessing> => {
			const base = acquiredContent ? resource : await loadResourceForProcessing(this.env, resourceId);
			const extractedPdfText = pdfTextArtifact?.text?.trim();
			return extractedPdfText ? { ...base, content: extractedPdfText } : base;
		};

		const paperEnrichment = await stagePaperEnrichment(this.env, step, resource).catch((error) => {
			console.error({
				tag: 'ACADEMIC_ENRICHMENT',
				msg: 'Optional Semantic Scholar enrichment failed',
				resource_id: resourceId,
				error: String(error),
			});
			return null;
		});
		const ogImagePatch = await stageOgImagePatch(step, resource, acquiredContent, operation === 'resync');

		const platformEnrichments =
			resourceType === 'hackernews'
				? await step.do(
						'generate-hacker-news-editorial',
						{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '600 seconds' },
						() => generateHackerNewsEnrichments(resource, this.env, acquiredContent?.hackerNewsItem),
					)
				: undefined;

		const classificationResult = await step.do(
			'classify-resource',
			{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '600 seconds' },
			async () => {
				const fullResource = await loadFull();
				const prepared = resourceType === 'twitter' ? prepareTwitterClassification(fullResource) : null;
				const resourceToClassify = prepared?.resource ?? fullResource;
				const classification = await generateResourceClassification(resourceToClassify, this.env);
				return mergeResourceClassification(resourceToClassify, classification, {
					updateData: prepared?.updateData,
					extraTags: resourceType === 'twitter' ? ['Twitter'] : resourceType === 'hackernews' ? ['HackerNews'] : undefined,
				});
			},
		);
		const processorResult = { ...classificationResult, ...(platformEnrichments ? { enrichments: platformEnrichments } : {}) };

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
				const resourceToPersist = pdfTextArtifact?.text || acquiredContent ? await loadFull() : resource;
				return persistProcessedResource(this.env, {
					resourceId,
					resource: resourceToPersist,
					processorResult,
					pdfTextArtifact,
					acquisitionExtraction: acquiredContent?.extraction,
					paperEnrichment,
					ogImagePatch,
					youtubeTranscript,
					youtubeHighlights,
				});
			},
		);
		const translationSourceHash = await step
			.do(
				'load-resource-translation-source-hash',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() => getPersistedResourceContentHashForTranslation(this.env, persistedResourceId),
			)
			.catch((error) => {
				console.error({
					tag: 'RESOURCE_TRANSLATION',
					msg: 'Failed to inspect persisted resource for translation',
					resource_id: persistedResourceId,
					error: String(error),
				});
				return null;
			});
		if (translationSourceHash) {
			await step
				.do(
					'enqueue-resource-translation',
					{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
					() => enqueueResourceTranslation(this.env, persistedResourceId, translationSourceHash),
				)
				.catch((error) =>
					console.error({
						tag: 'WORKFLOW',
						msg: 'Failed to enqueue resource translation',
						resource_id: persistedResourceId,
						error: String(error),
					}),
				);
		}
		await step
			.do('sync-ai-search', { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' }, () =>
				syncCorpusItem(this.env, persistedResourceId),
			)
			.catch((error) =>
				console.error({
					tag: 'AI_SEARCH',
					msg: 'Failed to sync enriched resource; reindex can repair it',
					resource_id: persistedResourceId,
					error: String(error),
				}),
			);

		console.info({ tag: 'WORKFLOW', msg: 'Completed', resource_id: persistedResourceId, table: 'resources' });
		return {
			success: true,
			resource_id: persistedResourceId,
			...(operation !== 'ingest' ? { operation, changed: true } : {}),
		};
	}
}
