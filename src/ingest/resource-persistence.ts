import type { ContentResourceType, ResourceTranslationSource } from '@core-shared/resource-types';
import type { PaperMetadata, ResourceForProcessing, YoutubeTranscript } from '@core-shared/types';
import { type CoreDb, withCoreDb, withCoreTx } from '@db/client';
import { entities, entityTranslations, resourceEntities, resources } from '@db/schema';
import {
	canonicalizeEntityName,
	normalizeResourceEntitiesForStorage,
	normalizeResourceEntityUpdatePayload,
	type ResourceEntityInput,
} from '@entities/normalize';
import { updateResourceAfterProcessing } from '@ingest/domain/resource-store';
import { and, eq, inArray, not, sql } from 'drizzle-orm';
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

async function syncResourceEntities(
	db: CoreDb,
	resourceId: string,
	inputEntities: ResourceEntityInput[],
	resourceType: ContentResourceType,
	source?: string | null,
	platformMetadata?: unknown,
): Promise<void> {
	const normalizedEntities = normalizeResourceEntitiesForStorage(inputEntities, resourceType, source, platformMetadata);
	const entityIds: string[] = [];

	for (const entity of normalizedEntities) {
		const canonical = canonicalizeEntityName(entity.name);
		if (!canonical) continue;

		const [row] = await db
			.insert(entities)
			.values({ canonicalName: canonical, name: entity.name, type: entity.type })
			.onConflictDoUpdate({
				target: entities.canonicalName,
				set: {
					name: entity.name,
					type: entity.type,
					updatedAt: sql`NOW()`,
				},
			})
			.returning({ id: entities.id });
		const entityId = row?.id;
		if (!entityId) throw new Error(`Failed to sync entity ${canonical}: no entity id returned`);
		entityIds.push(entityId);
		await upsertEntityTranslationRows(db, entityId, entity);
	}

	if (entityIds.length) {
		await db
			.delete(resourceEntities)
			.where(and(eq(resourceEntities.resourceId, resourceId), not(inArray(resourceEntities.entityId, entityIds))));
	} else {
		await db.delete(resourceEntities).where(eq(resourceEntities.resourceId, resourceId));
	}

	for (const entityId of entityIds) {
		await db.insert(resourceEntities).values({ resourceId, entityId }).onConflictDoNothing();
	}

	console.info({
		tag: 'ENTITIES',
		msg: 'Synced resource links',
		resourceId,
		inputCount: inputEntities.length,
		count: normalizedEntities.length,
		filteredCount: inputEntities.length - normalizedEntities.length,
	});
}

async function upsertEntityTranslationRows(db: CoreDb, entityId: string, entity: ResourceEntityInput): Promise<void> {
	const labels: Array<{ lang: string; name: string; source: ResourceTranslationSource }> = [
		{ lang: 'en', name: entity.name, source: 'original' },
	];
	if (entity.name_cn.trim()) labels.push({ lang: 'zh-Hant', name: entity.name_cn, source: 'machine' });

	for (const label of labels) {
		await db
			.insert(entityTranslations)
			.values({ entityId, lang: label.lang, name: label.name, source: label.source })
			.onConflictDoUpdate({
				target: [entityTranslations.entityId, entityTranslations.lang],
				set: {
					name: sql`CASE
						WHEN ${entityTranslations.source} = 'human' AND excluded.source <> 'human' THEN ${entityTranslations.name}
						ELSE excluded.name
					END`,
					source: sql`CASE
						WHEN ${entityTranslations.source} = 'human' AND excluded.source <> 'human' THEN ${entityTranslations.source}
						WHEN ${entityTranslations.source} = 'original' THEN ${entityTranslations.source}
						ELSE excluded.source
					END`,
					updatedAt: sql`NOW()`,
				},
			});
	}
}
