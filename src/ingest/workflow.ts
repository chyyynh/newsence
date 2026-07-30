import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import {
	hasSemanticScholarAcademicEnrichment,
	needsResourcePlatformAcquisition,
	parseResourceIdentity,
	resourceIdentityWithAcademic,
} from '@core-shared/resource-types';
import type { ResourceForProcessing } from '@core-shared/types';
import { loadResourceForProcessing, loadResourceShellForProcessing } from '@ingest/domain/resource-store';
import { loadFeedSourcePolicy } from '@ingest/domain/source-store';
import { syncCorpusItem } from '../ai-search';
import { enqueueOrRestartWorkflow } from '../workflow-control';
import {
	type AcquiredContent,
	applyAcquiredContent,
	PDF_MIME,
	pdfExtractionMetadata,
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
	persistPdfExtractionSnapshot,
	persistProcessedResource,
	persistResourceImageSnapshot,
	persistUnchangedResourceResync,
} from './resource-persistence';

type WorkflowOperation = 'ingest' | 'resync';
type WorkflowPayload = { resourceId: string; operation: WorkflowOperation };

export async function enqueueProcessing(env: CoreEnv, resourceId: string): Promise<string> {
	return enqueueOrRestartWorkflow(env.RESOURCE_PROCESSING_V2_WORKFLOW, storedWorkflowId(resourceId), {
		resourceId,
		operation: 'ingest',
	});
}

export async function enqueueResourceResync(env: CoreEnv, resourceId: string): Promise<string> {
	return enqueueOrRestartWorkflow(env.RESOURCE_PROCESSING_V2_WORKFLOW, `resource-resync-v2-${workflowIdPart(resourceId)}`, {
		resourceId,
		operation: 'resync',
	});
}

function workflowIdPart(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
}

function storedWorkflowId(resourceId: string): string {
	return ['resource-v2', workflowIdPart(resourceId)].join('-');
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
	const needsYouTubeAcquisition = resource.resource_platform === 'youtube' && !resource.has_youtube_transcript;
	const needsPlatformAcquisition = needsResourcePlatformAcquisition({
		platformData: resource.platform_metadata?.data,
		resourcePlatform: resource.resource_platform,
	});
	const needsAcquisitionIdentity = !resource.source || !resource.platform_metadata;
	return (
		(!hasContent || needsYouTubeAcquisition || needsPlatformAcquisition || needsAcquisitionIdentity) &&
		!resource.storage_key &&
		!!resource.url
	);
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
		await step.do('acquire-content-kind-platform-v1', ACQUISITION_STEP, () => scrapeSavedUrlArtifact(sourceUrl, env, origin)),
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

function feedSourceId(resource: ResourceForProcessing): string | null {
	// A detected special platform remains authoritative even when its URL came
	// from an RSS/Atom source. Feed content policy applies only to generic docs.
	return resource.resource_platform === null && resource.source_acquisition_mode === 'feed' ? resource.source_id : null;
}

async function stageRssFeedAcquisition(env: CoreEnv, step: WorkflowStep, input: RssFeedAcquisitionInput): Promise<AcquiredContent> {
	return readAcquiredContentArtifact(
		await step.do('acquire-rss-feed-content-kind-platform-v1', ACQUISITION_STEP, () => scrapeRssFeedItemArtifact(input, env)),
	);
}

async function persistPdfExtractionBeforeValidation(
	env: CoreEnv,
	step: WorkflowStep,
	input: {
		acquiredExtraction: AcquiredContent['extraction'];
		operation: WorkflowOperation;
		pdfTextArtifact: Awaited<ReturnType<typeof stagePdfTextExtraction>> | null;
		resource: ResourceForProcessing;
		resourceId: string;
	},
): Promise<boolean> {
	const extraction = input.pdfTextArtifact ? pdfExtractionMetadata(input.pdfTextArtifact) : input.acquiredExtraction;
	if (extraction && (input.pdfTextArtifact !== null || input.operation === 'resync')) {
		const persisted = await step.do(
			'persist-resource-pdf-extraction-snapshot-v1',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			() => persistPdfExtractionSnapshot(env, input.resourceId, input.resource, extraction),
		);
		if (!persisted) return false;
	}
	if (extraction?.status === 'needs_ocr') {
		throw new NonRetryableError(`PDF resource ${input.resourceId} requires OCR`, 'PdfOcrRequiredError');
	}
	return true;
}

async function acquireResourceForOperation(
	env: CoreEnv,
	step: WorkflowStep,
	resource: ResourceForProcessing,
	operation: WorkflowOperation,
): Promise<AcquiredContent | undefined> {
	if (!shouldAcquireContent(resource, operation === 'resync')) return undefined;
	const sourceId = feedSourceId(resource);
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

function requireProcessingResourceIdentity(resource: ResourceForProcessing) {
	const identity = parseResourceIdentity(resource.kind, resource.resource_platform);
	if (identity) return identity;
	throw new NonRetryableError(
		`Resource ${resource.id} has invalid identity ${String(resource.kind)} / ${String(resource.resource_platform)}`,
		'ResourceIdentityError',
	);
}

export class ResourceProcessingV2Workflow extends WorkflowEntrypoint<CoreEnv, WorkflowPayload> {
	async run(event: WorkflowEvent<WorkflowPayload>, step: WorkflowStep) {
		const { resourceId, operation } = event.payload;
		try {
			return await this.runResource(resourceId, step, operation);
		} catch (error) {
			if (operation === 'resync') throw error;
			// Cleanup must not throw: whatever it raises would replace `error`
			// as the instance's top-level failure. Do not delete the search
			// document here. Successful persistence is the only path that writes
			// it, and a concurrent newer workflow may have refreshed it after
			// this workflow failed.
			const logCleanupFailure = (msg: string) => (cleanupError: unknown) =>
				console.error({
					tag: 'WORKFLOW',
					msg,
					resource_id: resourceId,
					error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
				});
			await step
				.do(
					'mark-resource-failed-if-not-enriched-v1',
					{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
					() => markResourceEnrichmentFailed(this.env, resourceId),
				)
				.catch(logCleanupFailure('Failed to mark resource as failed'));
			throw error;
		}
	}

	private async runResource(resourceId: string, step: WorkflowStep, operation: WorkflowOperation) {
		const initialResource = await step.do(
			'fetch-resource-shell-kind-platform-v1',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => loadResourceShellForProcessing(this.env, resourceId),
		);
		if (operation === 'resync' && !initialResource.url) {
			throw new NonRetryableError(`Resource ${resourceId} has no source URL`, 'ResourceResyncUnsupportedError');
		}
		const acquiredContent = await acquireResourceForOperation(this.env, step, initialResource, operation);
		const acquiredResource = await stageTweetLinkUnfurl(step, applyAcquiredContent(initialResource, acquiredContent));
		const paperEnrichment = await stagePaperEnrichment(this.env, step, acquiredResource);
		const acquiredIdentity = requireProcessingResourceIdentity(acquiredResource);
		const identity = resourceIdentityWithAcademic(
			acquiredIdentity,
			!!paperEnrichment || hasSemanticScholarAcademicEnrichment(acquiredResource.platform_metadata),
		);
		const resource: ResourceForProcessing = {
			...acquiredResource,
			kind: identity.kind,
			resource_platform: identity.resourcePlatform,
		};
		const previousSnapshotHash = initialResource.platform_metadata?.sourceSnapshotHash;
		const nextSnapshotHash = acquiredContent?.platformMetadata?.sourceSnapshotHash;
		if (operation === 'resync' && previousSnapshotHash && previousSnapshotHash === nextSnapshotHash && acquiredContent) {
			const persistence = await step.do(
				'record-unchanged-resync-index-relevance-v2',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() => persistUnchangedResourceResync(this.env, resourceId, resource, paperEnrichment),
			);
			if (!persistence.persisted) {
				return { success: true, resource_id: resourceId, operation, changed: false, superseded: true };
			}
			await stageResourceImageRehost(this.env, step, resourceId);
			if (persistence.indexRelevantChanged) {
				// Branch only on the persisted step result so replay sees the same
				// decision. Let exhausted sync retries fail the resync instead of
				// reporting success with a known index drift.
				await step.do(
					'sync-ai-search-unchanged-resync-index-relevance-v1',
					{ retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
					() => syncCorpusItem(this.env, resourceId),
				);
			}
			return {
				success: true,
				resource_id: resourceId,
				operation,
				changed: false,
				metadata_changed: persistence.changed,
				index_relevant_changed: persistence.indexRelevantChanged,
			};
		}
		const logContext = { resource_id: resourceId, table: 'resources' };

		console.info({
			tag: 'WORKFLOW',
			msg: 'Starting',
			resourceKind: resource.kind,
			resourcePlatform: resource.resource_platform,
			...logContext,
		});
		if (operation === 'ingest') {
			const persisted = await step.do(
				'persist-resource-acquisition-snapshot-kind-platform-v1',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() => persistResourceImageSnapshot(this.env, resourceId, resource, paperEnrichment),
			);
			if (!persisted) return { success: true, resource_id: resourceId, operation, superseded: true };
			await stageResourceImageRehost(this.env, step, resourceId);
		}

		const hasContent = 'has_content' in resource && !!resource.has_content;
		const pdfTextArtifact =
			!hasContent && resource.storage_key && resource.file_type === PDF_MIME
				? await stagePdfTextExtraction(this.env, step, {
						sourceStorageKey: resource.storage_key,
					})
				: null;
		const extractionSnapshotCurrent = await persistPdfExtractionBeforeValidation(this.env, step, {
			acquiredExtraction: acquiredContent?.extraction,
			operation,
			pdfTextArtifact,
			resource,
			resourceId,
		});
		if (!extractionSnapshotCurrent) {
			return { success: true, resource_id: resourceId, operation, superseded: true };
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
			resource.resource_platform === 'hackernews'
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
					resource.resource_platform === 'twitter' ? ['Twitter'] : resource.resource_platform === 'hackernews' ? ['HackerNews'] : undefined,
				);
			},
		);
		const processorResult = {
			...classificationResult,
			...(hackerNewsContent ? { content: hackerNewsContent } : {}),
		};

		const youtubeTranscript = resource.resource_platform === 'youtube' ? acquiredContent?.youtubeTranscript : undefined;
		const youtubeHighlights =
			resource.resource_platform === 'youtube'
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
		const persistence = await step.do(
			'update-db-kind-platform-v1',
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
		if (!persistence.persisted) {
			return { success: true, resource_id: persistence.resourceId, operation, superseded: true };
		}
		const persistedResourceId = persistence.resourceId;
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
