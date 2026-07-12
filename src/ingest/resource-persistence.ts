import type { PaperMetadata, ResourceForProcessing, YoutubeTranscript } from '@core-shared/types';
import { withCoreDb, withCoreTx } from '@db/client';
import { resources } from '@db/schema';
import { normalizeResourceEntityUpdatePayload } from '@entities/normalize';
import { syncResourceEntities } from '@ingest/domain/resource-entity-store';
import { updateResourceAfterProcessing } from '@ingest/domain/resource-store';
import { eq, sql } from 'drizzle-orm';
import { type PdfExtractionMetadata, pdfExtractionMetadata } from './acquisition';
import type { ProcessorResult } from './domain/ai-utils';
import { buildResourceUpdate } from './domain/resource-update';
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

export async function markResourceEnrichmentFailed(env: CoreEnv, resourceId: string): Promise<void> {
	await withCoreDb(env, async (db) => {
		const updated = await db
			.update(resources)
			.set({ enrichmentStatus: 'failed', updatedAt: sql`NOW()` })
			.where(eq(resources.id, resourceId))
			.returning({ id: resources.id });
		if (!updated.length) throw new Error(`Failed to mark resource ${resourceId} as failed: not found`);
	});
}

export async function persistUnchangedResourceResync(env: CoreEnv, resourceId: string, resource: ResourceForProcessing): Promise<void> {
	if (!resource.platform_metadata) throw new Error(`Cannot resync resource ${resourceId} without platform metadata`);
	const previewImageUrl = resource.og_image_url?.trim() || null;
	await withCoreDb(env, async (db) => {
		const updated = await db
			.update(resources)
			.set({
				scrapedDate: new Date(),
				ogImageUrl: previewImageUrl,
				platformMetadata: resource.platform_metadata,
				updatedAt: new Date(),
			})
			.where(eq(resources.id, resourceId))
			.returning({ id: resources.id });
		if (!updated.length) throw new Error(`Failed to record resource ${resourceId} resync: not found`);
	});
}

export async function persistProcessedResource(env: CoreEnv, input: PersistProcessedResourceInput): Promise<string> {
	return withCoreTx(env, async (db) => {
		const extraction = input.pdfTextArtifact ? pdfExtractionMetadata(input.pdfTextArtifact) : input.acquisitionExtraction;
		const updatePayload = buildResourceUpdate(input.resource, {
			extraction,
			paperEnrichment: input.paperEnrichment,
			previewImageUrl: input.previewImageUrl,
			processorResult: input.processorResult,
		});
		if (!updatePayload.content?.trim()) {
			throw new Error(`Refusing to persist enriched resource ${input.resourceId} without content`);
		}
		const resourceType = updatePayload.type;
		const platformMetadata = updatePayload.platform_metadata;
		const resourceEntities = normalizeResourceEntityUpdatePayload(updatePayload, resourceType, input.resource.source, platformMetadata);
		const resourceId = await updateResourceAfterProcessing(db, input.resourceId, input.resource, updatePayload);
		if (resourceEntities) {
			await syncResourceEntities(db, resourceId, resourceEntities, resourceType, input.resource.source, platformMetadata);
		}
		if (input.youtubeTranscript || input.youtubeHighlights) {
			await persistYouTubeWorkflowData(db, {
				transcript: input.youtubeTranscript,
				highlights: input.youtubeHighlights,
			});
		}
		return resourceId;
	});
}
