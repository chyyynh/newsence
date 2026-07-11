import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { ResourceForProcessing } from '@core-shared/types';
import { loadResourceForProcessing } from '@ingest/domain/resource-store';
import { syncCorpusItem } from '../ai-search';
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
import { enqueueContentLocalization } from './content-localization-workflow';
import { generateResourceClassification, mergeResourceClassification } from './domain/ai-utils';
import { getPersistedResourceContentHashForLocalization } from './domain/content-localization-store';
import { applyAcquiredContent } from './domain/resource-update';
import { processHackerNewsResource } from './platforms/hackernews';
import { stagePaperEnrichment, syncPaperGraphForEnrichment } from './platforms/paper';
import { stagePdfTextExtraction } from './platforms/pdf';
import { processTwitterResource } from './platforms/twitter';
import { prepareYouTubeHighlights } from './platforms/youtube';
import {
	deleteResource,
	markResourceEnrichmentFailed,
	persistProcessedResource,
	persistUnchangedResourceResync,
} from './resource-persistence';

type WorkflowOperation = 'ingest' | 'resync';
type WorkflowPayload = { resourceId: string; operation?: WorkflowOperation };

export function enqueueProcessing(env: CoreEnv, resourceId: string): Promise<string> {
	return enqueueOrRestartWorkflow(env.MONITOR_WORKFLOW, storedWorkflowId(resourceId), { resourceId });
}

export function enqueueResourceResync(env: CoreEnv, resourceId: string): Promise<string> {
	return enqueueOrRestartWorkflow(env.MONITOR_WORKFLOW, `resource-resync-${workflowIdPart(resourceId)}`, {
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

async function stageSavedUrlAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	resource: ResourceForProcessing,
	allowFeedFallback: boolean,
): Promise<AcquiredContent | undefined> {
	try {
		const artifact = await step.do(
			'acquire-content',
			{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
			async () => {
				try {
					return await scrapeSavedUrlArtifact(resource.url, env, {
						allowRenderedFallback: resource.scope === 'corpus' && resource.type === 'rss',
					});
				} catch (error) {
					if (acquisitionHttpStatus(error) !== 403) throw error;
					throw new NonRetryableError(error instanceof Error ? error.message : String(error), 'AcquisitionForbiddenError');
				}
			},
		);
		return readAcquiredContentArtifact(artifact);
	} catch (error) {
		const hasFeedFallback = allowFeedFallback && resource.type === 'rss' && !!(resource.summary?.trim() || resource.content?.trim());
		if (!hasFeedFallback) throw error;
		console.warn({
			tag: 'WORKFLOW',
			msg: 'URL acquisition failed; continuing with RSS feed content',
			resource_id: resource.id,
			url: resource.url,
			error: String(error),
		});
		return undefined;
	}
}

type AcquisitionTerminalResult = {
	resourceId: string;
	deleted: boolean;
	reason: 'acquisition_http_403';
};

async function deleteResourceAfterAcquisition(
	env: CoreEnv,
	step: WorkflowStep,
	resource: ResourceForProcessing,
	input: {
		stepName: string;
		message: string;
		reason: AcquisitionTerminalResult['reason'];
		error?: unknown;
	},
): Promise<AcquisitionTerminalResult> {
	const deleted = await step.do(
		input.stepName,
		{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
		() => deleteResource(env, resource.id),
	);
	console.info({
		tag: 'WORKFLOW',
		msg: input.message,
		resource_id: resource.id,
		url: resource.url,
		deleted,
		...(input.error === undefined ? {} : { error: String(input.error) }),
	});
	return { resourceId: resource.id, deleted, reason: input.reason };
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
		acquiredContent = await stageSavedUrlAcquisition(env, step, resource, operation === 'ingest');
	} catch (error) {
		if (operation === 'resync' || acquisitionHttpStatus(error) !== 403) throw error;
		return {
			terminal: await deleteResourceAfterAcquisition(env, step, resource, {
				stepName: 'delete-forbidden-resource',
				message: 'Deleted resource after forbidden acquisition response',
				reason: 'acquisition_http_403',
				error,
			}),
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
	if ((!force && resource.og_image_url) || !resource.url || resource.file_type === PDF_MIME) return EMPTY_OG_IMAGE_PATCH;
	return step.do('resolve-og-image', { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '30 seconds' }, () =>
		fetchOgImage(resource.url),
	);
}

export class NewsenceMonitorWorkflow extends WorkflowEntrypoint<CoreEnv, WorkflowPayload> {
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

		// Reread durable rows unless in-memory acquisition already holds the freshest copy; PDF text always wins.
		const loadFull = async (): Promise<ResourceForProcessing> => {
			const base = acquiredContent ? resource : await loadResourceForProcessing(this.env, resourceId);
			const extractedPdfText = pdfTextArtifact?.text?.trim();
			return extractedPdfText ? { ...base, content: extractedPdfText } : base;
		};

		const paperEnrichment = await stagePaperEnrichment(this.env, step, resource, {
			hasStagedText: !!pdfTextArtifact?.text,
			loadContent: async () => (await loadFull()).content,
		});
		const ogImagePatch = await stageOgImagePatch(step, resource, acquiredContent, operation === 'resync');

		const processorResult = await step.do(
			'ai-analysis',
			{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '600 seconds' },
			async () => {
				const fullResource = await loadFull();
				if (resourceType === 'hackernews') return processHackerNewsResource(fullResource, this.env);
				if (resourceType === 'twitter') return processTwitterResource(fullResource, this.env);
				return mergeResourceClassification(fullResource, await generateResourceClassification(fullResource, this.env));
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
		await step.do('sync-ai-search', { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' }, () =>
			syncCorpusItem(this.env, persistedResourceId),
		);

		const localizationSourceHash = await step.do(
			'verify-persisted-original-content',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			() => getPersistedResourceContentHashForLocalization(this.env, persistedResourceId),
		);
		if (localizationSourceHash) {
			await step
				.do(
					'enqueue-content-localization',
					{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
					() => enqueueContentLocalization(this.env, persistedResourceId, localizationSourceHash),
				)
				.catch((error) =>
					console.error({
						tag: 'WORKFLOW',
						msg: 'Failed to enqueue dedicated content localization',
						resource_id: persistedResourceId,
						error: String(error),
					}),
				);
		}
		await syncPaperGraphForEnrichment(this.env, step, persistedResourceId, paperEnrichment);

		console.info({ tag: 'WORKFLOW', msg: 'Completed', resource_id: persistedResourceId, table: 'resources' });
		return {
			success: true,
			resource_id: persistedResourceId,
			...(operation !== 'ingest' ? { operation, changed: true } : {}),
		};
	}
}
