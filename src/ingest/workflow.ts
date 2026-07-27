import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { ResourceForProcessing } from '@core-shared/types';
import { loadResourceForProcessing, loadResourceShellForProcessing } from '@ingest/domain/resource-store';
import { loadFeedSourcePolicy } from '@ingest/domain/source-store';
import { deleteCorpusItem, syncCorpusItem } from '../ai-search';
import { enqueueOrRestartWorkflow } from '../workflow-control';
import {
	type AcquiredContent,
	applyAcquiredContent,
	PDF_MIME,
	readAcquiredContentArtifact,
	scrapeRssFeedItemArtifact,
	scrapeSavedUrlArtifact,
} from './acquisition';
import { enqueueResourceTranslation, isResourceTranslationEligible } from './content-localization-workflow';
import { classifyResource } from './domain/ai-utils';
import { buildHackerNewsContent } from './platforms/hackernews';
import { stagePaperEnrichment } from './platforms/paper';
import { stagePdfTextExtraction } from './platforms/pdf';
import type { RssFeedAcquisitionInput } from './platforms/rss-feed';
import { applyTweetLinkUnfurl, pendingTweetExternalLink, unfurlTweetExternalLink } from './platforms/twitter-unfurl';
import { prepareYouTubeHighlights } from './platforms/youtube';
import {
	markResourceEnrichmentFailed,
	persistProcessedResource,
	persistResourceImageSnapshot,
	persistUnchangedResourceResync,
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

async function stageResourceImageRehost(env: CoreEnv, step: WorkflowStep, resourceId: string): Promise<void> {
	await step
		.do(
			'rehost-resource-images',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
			async () => {
				const result = await env.DOMAIN.rehostResourceImages(resourceId);
				if (result.failed > 0) {
					const failures = result.outcomes
						.filter((outcome) => outcome.state === 'failed')
						.map((outcome) => `${outcome.sourceHost}:${outcome.failureCode}`)
						.join(', ');
					throw new Error(`Failed to rehost ${result.failed} of ${result.attempted} resource images (${failures})`);
				}
				console.info({
					tag: 'OG_IMAGE',
					event: 'eager_rehost_completed',
					resource_id: resourceId,
					attempted: result.attempted,
					available: result.available,
					derivatives_existing: result.derivativesExisting,
					derivatives_stored: result.derivativesStored,
				});
				return result;
			},
		)
		.catch((error) =>
			console.error({
				tag: 'OG_IMAGE',
				event: 'eager_rehost_failed',
				resource_id: resourceId,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
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

/**
 * Acquisition gets one attempt, not three.
 *
 * Measured, because the docs suggest otherwise: NonRetryableError thrown inside
 * a step does *not* skip its retries — three runs against a page with no
 * article recorded three attempts whether it was thrown from the step callback
 * or from the scraper, with the class serialised away to plain `Error` each
 * time. The only lever the platform actually honours is retries.limit.
 *
 * Setting it to 0 also removes a duplicated layer: a failed acquisition is
 * already retried by the monitors, on a 30m/1h/2h/4h backoff that gives up after
 * MAX_ENRICHMENT_ATTEMPTS. Ten-second retries only ever helped a blip shorter
 * than the outer schedule, and cost every doomed URL three fetches instead of
 * one.
 */
const ACQUISITION_STEP = { retries: { limit: 0, delay: '10 seconds' }, timeout: '120 seconds' } as const;

async function stageSavedUrlAcquisition(env: CoreEnv, step: WorkflowStep, resource: ResourceForProcessing): Promise<AcquiredContent> {
	const sourceUrl = resource.url;
	if (!sourceUrl) throw new Error(`Resource ${resource.id} has no source URL`);
	// A monitored source's feed decided to list this; anything else is a person's
	// explicit save, which feed policies must not veto.
	const origin = { monitored: !!resource.source_id };
	return readAcquiredContentArtifact(
		await step.do('acquire-content', ACQUISITION_STEP, () => scrapeSavedUrlArtifact(sourceUrl, env, origin)),
	);
}

/**
 * Fill `externalOgImage` / `externalTitle` for a share tweet so the link-preview
 * card can render (#235). Runs before both persist paths — including the
 * unchanged-resync short-circuit, which is how pre-existing rows get backfilled.
 */
async function stageTweetLinkUnfurl(step: WorkflowStep, resource: ResourceForProcessing): Promise<ResourceForProcessing> {
	const externalUrl = pendingTweetExternalLink(resource);
	if (!externalUrl) return resource;
	// Wrapped so a failed fetch (null) stays distinguishable from a page that
	// simply has no OG image ({ unfurl: null }) — both leave the card hidden.
	const outcome = await step
		.do('unfurl-tweet-external-link', { retries: { limit: 1, delay: '5 seconds' }, timeout: '30 seconds' }, async () => ({
			unfurl: await unfurlTweetExternalLink(externalUrl),
		}))
		.catch((error) => {
			// Legitimate absence: the URL still renders inline in the tweet text (#234).
			console.error({
				tag: 'TWITTER',
				msg: 'Optional external-link unfurl failed; card stays hidden',
				resource_id: resource.id,
				external_url: externalUrl,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		});
	if (!outcome) return resource;
	console.info({
		tag: 'TWITTER',
		msg: outcome.unfurl ? 'External link unfurled' : 'External link exposed no OG image',
		resource_id: resource.id,
		external_url: externalUrl,
	});
	return applyTweetLinkUnfurl(resource, outcome.unfurl);
}

function rssSourceId(resource: ResourceForProcessing): string | null {
	return resource.type === 'rss' ? resource.source_id : null;
}

async function stageRssFeedAcquisition(env: CoreEnv, step: WorkflowStep, input: RssFeedAcquisitionInput): Promise<AcquiredContent> {
	return readAcquiredContentArtifact(
		await step.do('acquire-rss-feed-content', ACQUISITION_STEP, () => scrapeRssFeedItemArtifact(input, env)),
	);
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
			() => loadFeedSourcePolicy(env, sourceId),
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
			// Neither cleanup step may throw: whatever they raise would replace
			// `error` as the instance's top-level failure, and the cause of the
			// failure is the only reason anyone opens this record. A broken
			// deleteCorpusItem masked every acquisition error this way.
			const logCleanupFailure = (msg: string) => (cleanupError: unknown) =>
				console.error({
					tag: 'WORKFLOW',
					msg,
					resource_id: resourceId,
					error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
				});
			await step
				.do('mark-resource-failed', { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' }, () =>
					markResourceEnrichmentFailed(this.env, resourceId),
				)
				.catch(logCleanupFailure('Failed to mark resource as failed'));
			await step
				.do(
					'remove-failed-resource-from-search-index',
					{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
					() => deleteCorpusItem(this.env, resourceId),
				)
				.catch(logCleanupFailure('Failed to remove failed resource from the search index'));
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
		const resource = await stageTweetLinkUnfurl(step, applyAcquiredContent(initialResource, acquiredContent));
		const paperEnrichment = await stagePaperEnrichment(this.env, step, resource);
		const previousSnapshotHash = initialResource.platform_metadata?.sourceSnapshotHash;
		const nextSnapshotHash = acquiredContent?.platformMetadata?.sourceSnapshotHash;
		if (operation === 'resync' && previousSnapshotHash && previousSnapshotHash === nextSnapshotHash && acquiredContent) {
			await step.do(
				'record-unchanged-resync',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() => persistUnchangedResourceResync(this.env, resourceId, resource, paperEnrichment),
			);
			await stageResourceImageRehost(this.env, step, resourceId);
			return { success: true, resource_id: resourceId, operation, changed: false };
		}
		const resourceType = resource.type;
		const logContext = { resource_id: resourceId, table: 'resources' };

		console.info({ tag: 'WORKFLOW', msg: 'Starting', resourceType, ...logContext });
		if (operation === 'ingest') {
			await step.do(
				'persist-resource-image-snapshot',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() => persistResourceImageSnapshot(this.env, resourceId, resource),
			);
			await stageResourceImageRehost(this.env, step, resourceId);
		}

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
				return classifyResource(
					resourceToClassify,
					this.env,
					resourceType === 'twitter' ? ['Twitter'] : resourceType === 'hackernews' ? ['HackerNews'] : undefined,
				);
			},
		);
		const processorResult = {
			...classificationResult,
			...(hackerNewsContent ? { content: hackerNewsContent } : {}),
		};

		const youtubeTranscript = resourceType === 'youtube' ? acquiredContent?.youtubeTranscript : undefined;
		const youtubeHighlights =
			resourceType === 'youtube'
				? await step
						.do(
							'prepare-youtube-highlights',
							{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
							async () => prepareYouTubeHighlights(this.env, resource, youtubeTranscript),
						)
						.catch((error) => {
							console.error({
								tag: 'YOUTUBE',
								msg: 'Optional YouTube highlights failed after retries',
								resource_id: resourceId,
								error: error instanceof Error ? error.message : String(error),
							});
							return null;
						})
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
		if (operation === 'resync') await stageResourceImageRehost(this.env, step, persistedResourceId);
		const translationEligible = await step
			.do(
				'check-resource-translation-eligibility',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() => isResourceTranslationEligible(this.env, persistedResourceId),
			)
			.catch((error) => {
				console.error({
					tag: 'RESOURCE_TRANSLATION',
					msg: 'Failed to inspect persisted resource for translation',
					resource_id: persistedResourceId,
					error: error instanceof Error ? error.message : String(error),
				});
				return false;
			});
		if (translationEligible) {
			await step
				.do(
					'enqueue-resource-translation',
					{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
					() => enqueueResourceTranslation(this.env, persistedResourceId),
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
