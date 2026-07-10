import type { PaperMetadata, ResourceForProcessing, YoutubeTranscript } from '@core-shared/types';
import { withCoreTx } from '@db/client';
import { normalizeResourceEntityUpdatePayload } from '@entities/normalize';
import { syncResourceEntities, updateResourceAfterProcessing } from '@ingest/domain/resource-store';
import { type OgImagePatch, type PdfExtractionMetadata, pdfExtractionMetadata } from './acquisition';
import type { ProcessorResult } from './domain/ai-utils';
import { ResourceUpdateBuilder } from './domain/resource-update';
import type { PdfTextArtifact } from './platforms/pdf';
import { persistYouTubeWorkflowData, type YouTubeHighlightsUpdate } from './platforms/youtube';

export type PersistProcessedResourceInput = {
	resourceId: string;
	resource: ResourceForProcessing;
	processorResult: ProcessorResult;
	embedding: number[] | null;
	pdfTextArtifact: PdfTextArtifact | null;
	acquisitionExtraction?: PdfExtractionMetadata;
	paperEnrichment: PaperMetadata | null;
	ogImagePatch: OgImagePatch;
	youtubeTranscript?: YoutubeTranscript;
	youtubeHighlights: YouTubeHighlightsUpdate | null;
};

export async function persistProcessedResource(env: CoreEnv, input: PersistProcessedResourceInput): Promise<string> {
	return withCoreTx(env, async (db) => {
		const extraction = input.pdfTextArtifact ? pdfExtractionMetadata(input.pdfTextArtifact) : input.acquisitionExtraction;
		const updatePayload = new ResourceUpdateBuilder(input.resource)
			.addExtractionMetadata(extraction)
			.addOgMetadata(input.ogImagePatch)
			.addPaperMetadata(input.paperEnrichment)
			.applyProcessorResult(input.processorResult, input.embedding)
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
