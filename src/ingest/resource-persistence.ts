import type { PaperMetadata, ResourceForProcessing, YoutubeTranscript } from '@core-shared/types';
import { withCoreDb, withCoreTx } from '@db/client';
import { resources } from '@db/schema';
import { normalizeResourceEntityUpdatePayload } from '@entities/normalize';
import { syncResourceEntities } from '@ingest/domain/resource-entity-store';
import { updateResourceAfterProcessing } from '@ingest/domain/resource-store';
import { eq, sql } from 'drizzle-orm';
import { deleteCorpusItem } from '../ai-search';
import { type AcquiredContent, type OgImagePatch, type PdfExtractionMetadata, pdfExtractionMetadata } from './acquisition';
import type { ProcessorResult } from './domain/ai-utils';
import { ResourceUpdateBuilder } from './domain/resource-update';
import type { PdfTextArtifact } from './platforms/pdf';
import { persistYouTubeWorkflowData, type YouTubeHighlightsUpdate } from './platforms/youtube';

export type PersistProcessedResourceInput = {
	resourceId: string;
	resource: ResourceForProcessing;
	processorResult: ProcessorResult;
	pdfTextArtifact: PdfTextArtifact | null;
	acquisitionExtraction?: PdfExtractionMetadata;
	paperEnrichment: PaperMetadata | null;
	ogImagePatch: OgImagePatch;
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

export async function deleteResource(env: CoreEnv, resourceId: string): Promise<boolean> {
	const deleted = await withCoreDb(env, async (db) => {
		const deleted = await db.delete(resources).where(eq(resources.id, resourceId)).returning({ id: resources.id });
		return deleted.length > 0;
	});
	if (deleted) await deleteCorpusItem(env, resourceId);
	return deleted;
}

export async function persistUnchangedResourceResync(env: CoreEnv, resourceId: string, acquired: AcquiredContent): Promise<void> {
	const platformMetadataJson = JSON.stringify(acquired.platformMetadata ?? {});
	const ogImageUrl = acquired.ogImage?.ogImageUrl?.trim() || null;
	await withCoreDb(env, async (db) => {
		const result = await db.execute(sql`
			UPDATE resources
			SET scraped_date = NOW(),
				og_image_url = COALESCE(${ogImageUrl}, og_image_url),
				platform_metadata = COALESCE(platform_metadata, '{}'::jsonb) || ${platformMetadataJson}::jsonb,
				updated_at = NOW()
			WHERE id = ${resourceId}::uuid
			RETURNING id
		`);
		if (!result.rows.length) throw new Error(`Failed to record resource ${resourceId} resync: not found`);
	});
}

export async function persistProcessedResource(env: CoreEnv, input: PersistProcessedResourceInput): Promise<string> {
	return withCoreTx(env, async (db) => {
		const extraction = input.pdfTextArtifact ? pdfExtractionMetadata(input.pdfTextArtifact) : input.acquisitionExtraction;
		const updatePayload = new ResourceUpdateBuilder(input.resource)
			.addExtractionMetadata(extraction)
			.addOgMetadata(input.ogImagePatch)
			.addPaperMetadata(input.paperEnrichment)
			.applyProcessorResult(input.processorResult)
			.applyOgFields(input.ogImagePatch)
			.build();
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
