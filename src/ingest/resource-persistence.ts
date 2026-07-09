import type { PaperMetadata, ResourceForProcessing, YoutubeTranscript } from '@core-shared/types';
import { withCoreTx } from '@db/client';
import { normalizeResourceEntityUpdatePayload } from '@entities/normalize';
import { syncResourceEntities, updateResourceAfterProcessing } from '@ingest/domain/resource-store';
import { type AcquiredContent, type OgImagePatch, pdfExtractionMetadata } from './acquisition';
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
	acquiredContent?: AcquiredContent;
	paperEnrichment: PaperMetadata | null;
	ogImagePatch: OgImagePatch;
	youtubeTranscript?: YoutubeTranscript;
	youtubeHighlights: YouTubeHighlightsUpdate | null;
};

export async function persistProcessedResource(env: CoreEnv, input: PersistProcessedResourceInput): Promise<string> {
	return withCoreTx(env, async (db) => {
		const finalResult =
			input.pdfTextArtifact?.text && input.resource.content
				? {
						...input.processorResult,
						updateData: { ...input.processorResult.updateData, content: input.resource.content },
					}
				: input.processorResult;
		const extraction = input.pdfTextArtifact ? pdfExtractionMetadata(input.pdfTextArtifact) : input.acquiredContent?.extraction;
		const updatePayload = new ResourceUpdateBuilder(input.resource)
			.addExtractionMetadata(extraction)
			.addOgMetadata(input.ogImagePatch)
			.addPaperMetadata(input.paperEnrichment)
			.applyAcquiredFields(input.acquiredContent)
			.applyProcessorResult(finalResult, input.embedding)
			.applyOgFields(input.ogImagePatch)
			.build();
		const platformMetadata = updatePayload.platform_metadata ?? input.resource.platform_metadata;
		const resourceEntities = normalizeResourceEntityUpdatePayload(updatePayload, input.resource.source, platformMetadata);
		const resourceId = await updateResourceAfterProcessing(db, input.resourceId, input.resource, updatePayload);
		if (resourceEntities) {
			await syncResourceEntities(db, resourceId, resourceEntities, input.resource.source, platformMetadata);
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
