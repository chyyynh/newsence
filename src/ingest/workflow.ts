import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { ResourceForProcessing } from '@core-shared/types';
import { loadResourceForProcessing, loadResourceShellForProcessing } from '@ingest/domain/resource-store';
import { loadRssSourcePolicy } from '@ingest/domain/source-store';
import { deleteCorpusItem, syncCorpusItem } from '../ai-search';
import { enqueueOrRestartWorkflow } from '../workflow-control';
import {
	type AcquiredContent,
	PDF_MIME,
	readAcquiredContentArtifact,
	scrapeRssFeedItemArtifact,
	scrapeSavedUrlArtifact,
} from './acquisition';
import { enqueueResourceTranslation, getPersistedResourceTranslationHash } from './content-localization-workflow';
import { generateResourceClassification, mergeResourceClassification } from './domain/ai-utils';
import { applyAcquiredContent } from './domain/resource-update';
import { buildHackerNewsContent } from './platforms/hackernews';
import { stagePaperEnrichment } from './platforms/paper';
import { stagePdfTextExtraction } from './platforms/pdf';
import type { RssFeedAcquisitionInput } from './platforms/rss-feed';
import { prepareYouTubeHighlights } from './platforms/youtube';
import { markResourceEnrichmentFailed, persistProcessedResource, persistUnchangedResourceResync } from './resource-persistence';

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
	const needsAcquisitionIdentity = !resource.source || !resource.platform_metadata;
	return (!hasContent || needsYouTubeAcquisition || needsAcquisitionIdentity) && !resource.storage_key && !!resource.url;
}

async function stageSavedUrlAcquisition(env: CoreEnv, step: WorkflowStep, resource: ResourceForProcessing): Promise<AcquiredContent> {
	const sourceUrl = resource.url;
	if (!sourceUrl) throw new Error(`Resource ${resource.id} has no source URL`);
	const artifact = await step.do(
		'acquire-content',
		{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
		() => scrapeSavedUrlArtifact(sourceUrl, env),
	);
	return readAcquiredContentArtifact(artifact);
}

function rssSourceId(resource: ResourceForProcessing): string | null {
	return resource.type === 'rss' ? resource.source_id : null;
}

async function stageRssFeedAcquisition(env: CoreEnv, step: WorkflowStep, input: RssFeedAcquisitionInput): Promise<AcquiredContent> {
	const artifact = await step.do(
		'acquire-rss-feed-content',
		{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
		() => scrapeRssFeedItemArtifact(input, env),
	);
	return readAcquiredContentArtifact(artifact);
}

async function acquireResourceForOperation(
	env: CoreEnv,
	step: WorkflowStep,
	resource: ResourceForProcessing,
	operation: WorkflowOperation,
): Promise<AcquiredContent | undefined> {
	if (!shouldAcquireContent(resource, operation === 'resync')) return undefined;
	const sourceId = rssSourceId(resource);
	if (sourceId) {
		const source = await step.do(
			'load-rss-source-policy',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			() => loadRssSourcePolicy(env, sourceId),
		);
		if (source.acquisitionMode === 'feed') {
			if (!resource.url) throw new Error(`RSS resource ${resource.id} has no article URL`);
			return stageRssFeedAcquisition(env, step, {
				feedUrl: source.handle,
				articleUrl: resource.url,
				sourceName: source.name,
			});
		}
	}
	return stageSavedUrlAcquisition(env, step, resource);
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
			async () => loadResourceShellForProcessing(this.env, resourceId),
		);
		if (operation === 'resync' && !initialResource.url) {
			throw new NonRetryableError(`Resource ${resourceId} has no source URL`, 'ResourceResyncUnsupportedError');
		}
		const acquiredContent = await acquireResourceForOperation(this.env, step, initialResource, operation);
		const resource = applyAcquiredContent(initialResource, acquiredContent);
		const previousSnapshotHash = initialResource.platform_metadata?.sourceSnapshotHash;
		const nextSnapshotHash = acquiredContent?.platformMetadata?.sourceSnapshotHash;
		if (operation === 'resync' && previousSnapshotHash && previousSnapshotHash === nextSnapshotHash && acquiredContent) {
			await step.do(
				'record-unchanged-resync',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() => persistUnchangedResourceResync(this.env, resourceId, resource),
			);
			return { success: true, resource_id: resourceId, operation, changed: false };
		}
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
				? await step
						.do(
							'build-hacker-news-content',
							{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '600 seconds' },
							async () => buildHackerNewsContent(await loadFull(), this.env, acquiredContent?.hackerNewsItem),
						)
						.catch((error) => {
							console.error({
								tag: 'HN',
								msg: 'Optional Hacker News discussion annotation failed after retries',
								resource_id: resourceId,
								error: error instanceof Error ? error.message : String(error),
							});
							return undefined;
						})
				: undefined;

		const classificationResult = await step.do(
			'classify-resource',
			{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '600 seconds' },
			async () => {
				const fullResource = await loadFull();
				const resourceToClassify = hackerNewsContent ? { ...fullResource, content: hackerNewsContent } : fullResource;
				const classification = await generateResourceClassification(resourceToClassify, this.env);
				return mergeResourceClassification(resourceToClassify, classification, {
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
				const resourceToPersist = await loadFull();
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
		const translationSourceHash = await step
			.do(
				'load-resource-translation-source-hash',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() => getPersistedResourceTranslationHash(this.env, persistedResourceId),
			)
			.catch((error) => {
				console.error({
					tag: 'RESOURCE_TRANSLATION',
					msg: 'Failed to inspect persisted resource for translation',
					resource_id: persistedResourceId,
					error: error instanceof Error ? error.message : String(error),
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
						tag: 'RESOURCE_TRANSLATION',
						msg: 'Failed to enqueue resource translation',
						resource_id: persistedResourceId,
						error: error instanceof Error ? error.message : String(error),
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
					error: error instanceof Error ? error.message : String(error),
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
