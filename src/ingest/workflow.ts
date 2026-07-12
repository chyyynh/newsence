import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { ResourceForProcessing } from '@core-shared/types';
import { loadResourceForProcessing } from '@ingest/domain/resource-store';
import { deleteCorpusItem, syncCorpusItem } from '../ai-search';
import { enqueueOrRestartWorkflow } from '../workflow-control';
import { type AcquiredContent, acquisitionHttpStatus, PDF_MIME, readAcquiredContentArtifact, scrapeSavedUrlArtifact } from './acquisition';
import { enqueueResourceTranslation, getPersistedResourceTranslationHash } from './content-localization-workflow';
import { generateResourceClassification, mergeResourceClassification } from './domain/ai-utils';
import { applyAcquiredContent } from './domain/resource-update';
import { buildHackerNewsContent } from './platforms/hackernews';
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
type WorkflowPayload = { resourceId: string; operation: WorkflowOperation };

export function enqueueProcessing(env: CoreEnv, resourceId: string): Promise<string> {
	return enqueueOrRestartWorkflow(env.RESOURCE_PROCESSING_WORKFLOW, storedWorkflowId(resourceId), { resourceId, operation: 'ingest' });
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

export class ResourceProcessingWorkflow extends WorkflowEntrypoint<CoreEnv, WorkflowPayload> {
	async run(event: WorkflowEvent<WorkflowPayload>, step: WorkflowStep) {
		const { resourceId, operation } = event.payload;
		try {
			return await this.runResource(resourceId, step, operation);
		} catch (error) {
			if (operation === 'resync') throw error;
			await step.do(
				'mark-resource-failed',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() => markResourceEnrichmentFailed(this.env, resourceId),
			);
			await step.do(
				'remove-failed-resource-from-search-index',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() => deleteCorpusItem(this.env, resourceId),
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
		if (pdfExtraction?.status === 'needs_ocr') {
			throw new NonRetryableError(`PDF resource ${resourceId} requires OCR`, 'PdfOcrRequiredError');
		}
		await step.do('validate-resource-content', { retries: { limit: 0, delay: '1 second' }, timeout: '5 seconds' }, async () => {
			const hasProcessableContent = hasContent || !!pdfTextArtifact?.text?.trim() || !!acquiredContent?.markdown?.trim();
			if (!hasProcessableContent) {
				throw new NonRetryableError(`Resource ${resourceId} has no extractable content`, 'ResourceContentMissingError');
			}
			return true;
		});

		// Reread durable rows unless in-memory acquisition already holds the freshest copy; PDF text always wins.
		const loadFull = async (): Promise<ResourceForProcessing> => {
			const base = acquiredContent ? resource : await loadResourceForProcessing(this.env, resourceId);
			const extractedPdfText = pdfTextArtifact?.text?.trim();
			return extractedPdfText ? { ...base, content: extractedPdfText } : base;
		};

		const paperEnrichment = await stagePaperEnrichment(this.env, step, resource);
		const previewImageUrl = acquiredContent?.previewImageUrl?.trim() || null;

		const hackerNewsContent =
			resourceType === 'hackernews'
				? await step.do(
						'build-hacker-news-content',
						{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '600 seconds' },
						async () => buildHackerNewsContent(await loadFull(), this.env, acquiredContent?.hackerNewsItem),
					)
				: undefined;

		const classificationResult = await step.do(
			'classify-resource',
			{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '600 seconds' },
			async () => {
				const fullResource = await loadFull();
				const resourceWithDiscussion = hackerNewsContent ? { ...fullResource, content: hackerNewsContent } : fullResource;
				const prepared = resourceType === 'twitter' ? prepareTwitterClassification(resourceWithDiscussion) : null;
				const resourceToClassify = prepared?.resource ?? resourceWithDiscussion;
				const classification = await generateResourceClassification(resourceToClassify, this.env);
				return mergeResourceClassification(resourceToClassify, classification, {
					updateData: prepared?.updateData,
					extraTags: resourceType === 'twitter' ? ['Twitter'] : resourceType === 'hackernews' ? ['HackerNews'] : undefined,
				});
			},
		);
		const processorResult = {
			...classificationResult,
			updateData: {
				...classificationResult.updateData,
				...(hackerNewsContent ? { content: hackerNewsContent } : {}),
			},
		};

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
					previewImageUrl,
					youtubeTranscript,
					youtubeHighlights,
				});
			},
		);
		const translationSourceHash = await step.do(
			'load-resource-translation-source-hash',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			() => getPersistedResourceTranslationHash(this.env, persistedResourceId),
		);
		if (translationSourceHash) {
			await step.do(
				'enqueue-resource-translation',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() => enqueueResourceTranslation(this.env, persistedResourceId, translationSourceHash),
			);
		}
		await step.do('sync-ai-search', { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' }, () =>
			syncCorpusItem(this.env, persistedResourceId),
		);

		console.info({ tag: 'WORKFLOW', msg: 'Completed', resource_id: persistedResourceId, table: 'resources' });
		return {
			success: true,
			resource_id: persistedResourceId,
			...(operation !== 'ingest' ? { operation, changed: true } : {}),
		};
	}
}
