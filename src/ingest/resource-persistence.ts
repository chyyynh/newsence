import type { PaperMetadata, PlatformMetadata, ResourceForProcessing, YoutubeTranscript } from '@core-shared/types';
import { withCoreDb, withCoreTx } from '@db/client';
import { resources } from '@db/schema';
import { toStoredResourceEntities } from '@entities/normalize';
import { updateResourceAfterProcessing } from '@ingest/domain/resource-store';
import { eq, sql } from 'drizzle-orm';
import { type PdfExtractionMetadata, pdfExtractionMetadata } from './acquisition';
import type { ProcessorResult } from './domain/ai-utils';
import type { PdfTextArtifact } from './platforms/pdf';
import { persistYouTubeWorkflowData, type YouTubeHighlightsUpdate } from './platforms/youtube';

type PersistProcessedResourceInput = {
	resourceId: string;
	resource: ResourceForProcessing;
	processorResult: ProcessorResult;
	pdfTextArtifact: PdfTextArtifact | null;
	acquisitionExtraction?: PdfExtractionMetadata;
	paperEnrichment: PaperMetadata | null;
	previewImageUrl: string | null;
	youtubeTranscript?: YoutubeTranscript;
	youtubeHighlights: YouTubeHighlightsUpdate | null;
};

type BuildResourceUpdateInput = {
	processorResult: ProcessorResult;
	extraction?: PdfExtractionMetadata;
	paperEnrichment?: PaperMetadata | null;
	previewImageUrl: string | null;
};

function mergePaperEnrichment(platformMetadata: PlatformMetadata, paperEnrichment?: PaperMetadata | null): PlatformMetadata {
	if (!paperEnrichment) return platformMetadata;
	return {
		...platformMetadata,
		enrichments: { ...(platformMetadata.enrichments || {}), academic: paperEnrichment },
	};
}

function withAcademicPublishedDate(resource: ResourceForProcessing, paperEnrichment?: PaperMetadata | null): ResourceForProcessing {
	if (resource.published_date || !paperEnrichment?.publicationDate) return resource;
	const publishedDate = new Date(`${paperEnrichment.publicationDate}T00:00:00.000Z`);
	if (Number.isNaN(publishedDate.getTime())) return resource;
	return { ...resource, published_date: publishedDate.toISOString() };
}

function buildResourceUpdate(resource: ResourceForProcessing, input: BuildResourceUpdateInput) {
	const { processorResult, extraction, paperEnrichment, previewImageUrl } = input;
	if (!resource.platform_metadata) throw new Error(`Cannot build update for resource ${resource.id} without platform metadata`);
	let platformMetadata = mergePaperEnrichment(resource.platform_metadata, paperEnrichment);
	platformMetadata = {
		...platformMetadata,
		classification: {
			...(platformMetadata.classification ?? {}),
			category: processorResult.category,
			classifiedAt: new Date().toISOString(),
		},
	};
	const sourceName = resource.source?.trim();
	if (!sourceName) throw new Error('Cannot build platform metadata without a source name');
	platformMetadata = { ...platformMetadata, ...(extraction ? { extraction } : {}), sourceName };

	return {
		summary: resource.summary,
		content: processorResult.content !== undefined ? processorResult.content : resource.content,
		tags: [...(processorResult.tags ?? resource.tags)],
		keywords: [...(processorResult.keywords ?? resource.keywords)],
		entities: toStoredResourceEntities(processorResult.entities, resource.type, resource.source, platformMetadata),
		og_image_url: previewImageUrl?.trim() || resource.og_image_url?.trim() || null,
		platform_metadata: platformMetadata,
	};
}

export async function markResourceEnrichmentFailed(env: CoreEnv, resourceId: string): Promise<void> {
	await withCoreDb(env, async (db) => {
		const updated = await db
			.update(resources)
			.set({
				enrichmentStatus: 'failed',
				// Counts consecutive failures so the monitors back off and eventually stop
				// re-enqueuing a URL that never resolves.
				enrichmentAttempts: sql`${resources.enrichmentAttempts} + 1`,
				updatedAt: sql`NOW()`,
			})
			.where(eq(resources.id, resourceId))
			.returning({ id: resources.id });
		if (!updated.length) throw new Error(`Failed to mark resource ${resourceId} as failed: not found`);
	});
}

export async function persistUnchangedResourceResync(
	env: CoreEnv,
	resourceId: string,
	resource: ResourceForProcessing,
	paperEnrichment?: PaperMetadata | null,
): Promise<void> {
	if (!resource.platform_metadata) throw new Error(`Cannot resync resource ${resourceId} without platform metadata`);
	const resourceWithDate = withAcademicPublishedDate(resource, paperEnrichment);
	const previewImageUrl = resourceWithDate.og_image_url?.trim() || null;
	const platformMetadata = mergePaperEnrichment(resource.platform_metadata, paperEnrichment);
	await withCoreDb(env, async (db) => {
		const updated = await db
			.update(resources)
			.set({
				scrapedDate: new Date(),
				publishedDate: resourceWithDate.published_date ? new Date(resourceWithDate.published_date) : null,
				ogImageUrl: previewImageUrl,
				platformMetadata,
				updatedAt: new Date(),
			})
			.where(eq(resources.id, resourceId))
			.returning({ id: resources.id });
		if (!updated.length) throw new Error(`Failed to record resource ${resourceId} resync: not found`);
	});
}

export async function persistAcademicMetadataBackfill(env: CoreEnv, resourceId: string, metadata: PaperMetadata): Promise<void> {
	await withCoreDb(env, async (_db, client) => {
		const publishedDate = metadata.publicationDate ? `${metadata.publicationDate}T00:00:00.000Z` : null;
		const result = await client.query<{ id: string }>(
			`
				UPDATE resources
				SET
					platform_metadata =
						CASE
							WHEN jsonb_typeof(platform_metadata) = 'object' THEN platform_metadata
							ELSE '{}'::jsonb
						END
						|| jsonb_build_object(
							'enrichments',
							CASE
								WHEN jsonb_typeof(platform_metadata->'enrichments') = 'object' THEN platform_metadata->'enrichments'
								ELSE '{}'::jsonb
							END
							|| jsonb_build_object('academic', $2::jsonb)
						),
					published_date = COALESCE(published_date, $3::timestamp),
					updated_at = NOW()
				WHERE id = $1::uuid
				RETURNING id::text AS id
			`,
			[resourceId, JSON.stringify(metadata), publishedDate],
		);
		if (result.rowCount !== 1) throw new Error(`Failed to persist academic metadata for resource ${resourceId}: not found`);
		console.info({
			tag: 'S2',
			event: 'academic_metadata_backfill_persisted',
			resource_id: resourceId,
			references_loaded: metadata.references.length,
			publication_date_available: !!publishedDate,
		});
	});
}

export async function persistResourceImageSnapshot(env: CoreEnv, resourceId: string, resource: ResourceForProcessing): Promise<void> {
	await withCoreDb(env, async (db) => {
		const updated = await db
			.update(resources)
			.set({
				type: resource.type,
				ogImageUrl: resource.og_image_url?.trim() || null,
				platformMetadata: resource.platform_metadata ?? null,
			})
			.where(eq(resources.id, resourceId))
			.returning({ id: resources.id });
		if (!updated.length) throw new Error(`Failed to persist resource ${resourceId} image snapshot: not found`);
	});
}

export async function persistProcessedResource(env: CoreEnv, input: PersistProcessedResourceInput): Promise<string> {
	return withCoreTx(env, async (db) => {
		const resource = withAcademicPublishedDate(input.resource, input.paperEnrichment);
		const extraction = input.pdfTextArtifact ? pdfExtractionMetadata(input.pdfTextArtifact) : input.acquisitionExtraction;
		const updatePayload = buildResourceUpdate(resource, {
			extraction,
			paperEnrichment: input.paperEnrichment,
			previewImageUrl: input.previewImageUrl,
			processorResult: input.processorResult,
		});
		if (!updatePayload.content?.trim()) {
			throw new Error(`Refusing to persist enriched resource ${input.resourceId} without content`);
		}
		const resourceId = await updateResourceAfterProcessing(db, input.resourceId, resource, updatePayload);
		console.info({
			tag: 'ENTITIES',
			msg: 'Stored resource entities',
			resourceId,
			inputCount: input.processorResult.entities.length,
			count: updatePayload.entities.length,
			filteredCount: input.processorResult.entities.length - updatePayload.entities.length,
		});
		if (input.youtubeTranscript || input.youtubeHighlights) {
			await persistYouTubeWorkflowData(db, {
				transcript: input.youtubeTranscript,
				highlights: input.youtubeHighlights,
			});
		}
		return resourceId;
	});
}
