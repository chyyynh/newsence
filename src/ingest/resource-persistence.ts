import type { ContentResourceType, ResourceTranslationSource } from '@core-shared/resource-types';
import type { PaperMetadata, PlatformMetadata, ResourceForProcessing, YoutubeTranscript } from '@core-shared/types';
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
	const updateData = processorResult.updateData;
	let platformMetadata = mergePaperEnrichment(resource.platform_metadata, paperEnrichment);
	if (processorResult.enrichments && Object.keys(processorResult.enrichments).length) {
		platformMetadata = {
			...platformMetadata,
			enrichments: {
				...(platformMetadata.enrichments || {}),
				...processorResult.enrichments,
				processedAt: new Date().toISOString(),
			},
		};
	}
	if (processorResult.classificationCategory) {
		platformMetadata = {
			...platformMetadata,
			classification: {
				...(platformMetadata.classification ?? {}),
				category: processorResult.classificationCategory,
				classifiedAt: new Date().toISOString(),
			},
		};
	}
	const sourceName = resource.source?.trim();
	if (!sourceName) throw new Error('Cannot build platform metadata without a source name');
	platformMetadata = { ...platformMetadata, ...(extraction ? { extraction } : {}), sourceName };

	return {
		summary: updateData.summary !== undefined ? updateData.summary : resource.summary,
		content: updateData.content !== undefined ? updateData.content : resource.content,
		tags: [...(updateData.tags ?? resource.tags)],
		keywords: [...(updateData.keywords ?? resource.keywords)],
		entities: updateData.entities,
		og_image_url: previewImageUrl?.trim() || resource.og_image_url?.trim() || null,
		platform_metadata: platformMetadata,
	};
}

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
		const resourceType = resource.type;
		const platformMetadata = updatePayload.platform_metadata;
		const entityInputs = normalizeResourceEntityUpdatePayload(updatePayload, resourceType, resource.source, platformMetadata);
		const resourceId = await updateResourceAfterProcessing(db, input.resourceId, resource, updatePayload);
		if (entityInputs) {
			await syncResourceEntities(db, resourceId, entityInputs, resourceType, resource.source, platformMetadata);
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
		await db
			.insert(resourceEntities)
			.values(entityIds.map((entityId) => ({ resourceId, entityId })))
			.onConflictDoNothing();
	} else {
		await db.delete(resourceEntities).where(eq(resourceEntities.resourceId, resourceId));
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

	await db
		.insert(entityTranslations)
		.values(labels.map((label) => ({ entityId, lang: label.lang, name: label.name, source: label.source })))
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
