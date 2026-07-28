import {
	hasSemanticScholarAcademicEnrichment,
	isIncomingResourceSnapshotSuperseded,
	isResourceType,
	legacyResourceIdentity,
	parseResourceIdentity,
	resourceIdentityWithAcademic,
} from '@core-shared/resource-types';
import type { PaperMetadata, PlatformMetadata, ResourceForProcessing, YoutubeTranscript } from '@core-shared/types';
import { type CoreDb, withCoreDb, withCoreTx } from '@db/client';
import { resources } from '@db/schema';
import { toStoredResourceEntities } from '@entities/normalize';
import { updateResourceAfterProcessing } from '@ingest/domain/resource-store';
import { and, eq, ne, sql } from 'drizzle-orm';
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

type LockedResourceState = {
	kind: string | null;
	platform_metadata: unknown;
	published_date: Date | string | null;
	resource_platform: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isPlatformMetadata(value: unknown): value is PlatformMetadata {
	return isRecord(value) && typeof value.fetchedAt === 'string' && Object.hasOwn(value, 'data');
}

function academicEnrichmentFrom(platformMetadata: unknown): PaperMetadata | null {
	if (!hasSemanticScholarAcademicEnrichment(platformMetadata)) return null;
	return (platformMetadata as { enrichments: { academic: PaperMetadata } }).enrichments.academic;
}

function academicTimestamp(metadata: PaperMetadata): number {
	const timestamp = Date.parse(metadata.metricsUpdatedAt || metadata.resolvedAt);
	return Number.isNaN(timestamp) ? 0 : timestamp;
}

function newestAcademicEnrichment(first: PaperMetadata | null, second: PaperMetadata | null): PaperMetadata | null {
	if (!first) return second;
	if (!second) return first;
	return academicTimestamp(second) > academicTimestamp(first) ? second : first;
}

function mergeLockedPlatformMetadata(resource: ResourceForProcessing, lockedPlatformMetadata: unknown): ResourceForProcessing {
	if (!isPlatformMetadata(lockedPlatformMetadata)) return resource;
	const current = resource.platform_metadata;
	if (!current) return { ...resource, platform_metadata: lockedPlatformMetadata };
	const lockedEnrichments = isRecord(lockedPlatformMetadata.enrichments) ? lockedPlatformMetadata.enrichments : {};
	return {
		...resource,
		platform_metadata: {
			...lockedPlatformMetadata,
			...current,
			enrichments: {
				...lockedEnrichments,
				...(current.enrichments ?? {}),
			},
		},
	};
}

async function lockResourceState(db: CoreDb, resourceId: string): Promise<LockedResourceState> {
	const result = await db.execute<LockedResourceState>(sql`
		SELECT kind, resource_platform, published_date, platform_metadata
		FROM resources
		WHERE id = ${resourceId}::uuid
		FOR UPDATE
	`);
	const lockedResource = result.rows[0];
	if (!lockedResource) throw new Error(`Failed to lock resource ${resourceId}: not found`);
	return lockedResource;
}

function mergeLockedResourceState(
	resource: ResourceForProcessing,
	lockedResource: LockedResourceState,
	incomingPaperEnrichment: PaperMetadata | null,
): { paperEnrichment: PaperMetadata | null; resource: ResourceForProcessing } {
	const lockedIdentity = parseResourceIdentity(lockedResource.kind, lockedResource.resource_platform);
	if ((lockedResource.kind !== null || lockedResource.resource_platform !== null) && !lockedIdentity) {
		throw new Error(
			`Cannot persist resource ${resource.id} with invalid stored identity ${String(lockedResource.kind)} / ${String(lockedResource.resource_platform)}`,
		);
	}
	const paperEnrichment = newestAcademicEnrichment(incomingPaperEnrichment, academicEnrichmentFrom(lockedResource.platform_metadata));
	let merged = mergeLockedPlatformMetadata(resource, lockedResource.platform_metadata);
	if (lockedIdentity?.kind === 'paper' && merged.kind === 'document' && lockedIdentity.resourcePlatform === merged.resource_platform) {
		merged = { ...merged, kind: 'paper' };
	}
	if (!merged.published_date && lockedResource.published_date) {
		const publishedDate = new Date(lockedResource.published_date);
		if (!Number.isNaN(publishedDate.getTime())) merged = { ...merged, published_date: publishedDate.toISOString() };
	}
	return {
		paperEnrichment,
		resource: withAcademicPublishedDate(withAcademicIdentity(merged, paperEnrichment), paperEnrichment),
	};
}

function resourceWriteIsSuperseded(resource: ResourceForProcessing, lockedResource: LockedResourceState, stage: string): boolean {
	if (!isIncomingResourceSnapshotSuperseded(resource.platform_metadata, lockedResource.platform_metadata)) return false;
	console.info({
		tag: 'RESOURCE_PERSIST',
		event: 'superseded_resource_write_skipped',
		resource_id: resource.id,
		stage,
	});
	return true;
}

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

function withAcademicIdentity(resource: ResourceForProcessing, paperEnrichment?: PaperMetadata | null): ResourceForProcessing {
	const identity = resourceIdentityWithAcademic({ kind: resource.kind, resourcePlatform: resource.resource_platform }, !!paperEnrichment);
	if (identity.kind === resource.kind && identity.resourcePlatform === resource.resource_platform) return resource;
	return { ...resource, kind: identity.kind, resource_platform: identity.resourcePlatform };
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
		entities: toStoredResourceEntities(processorResult.entities, resource.resource_platform, resource.source, platformMetadata),
		og_image_url: previewImageUrl?.trim() || resource.og_image_url?.trim() || null,
		platform_metadata: platformMetadata,
	};
}

export async function markResourceEnrichmentFailed(env: CoreEnv, resourceId: string): Promise<boolean> {
	return withCoreDb(env, async (db) => {
		const updated = await db
			.update(resources)
			.set({
				enrichmentStatus: 'failed',
				// Counts consecutive failures so the monitors back off and eventually stop
				// re-enqueuing a URL that never resolves.
				enrichmentAttempts: sql`${resources.enrichmentAttempts} + 1`,
				updatedAt: sql`NOW()`,
			})
			.where(and(eq(resources.id, resourceId), ne(resources.enrichmentStatus, 'enriched')))
			.returning({ id: resources.id });
		if (updated.length) return true;
		const existing = await db.select({ id: resources.id }).from(resources).where(eq(resources.id, resourceId)).limit(1);
		if (!existing.length) throw new Error(`Failed to mark resource ${resourceId} as failed: not found`);
		console.info({
			tag: 'RESOURCE_PERSIST',
			event: 'enriched_resource_failure_preserved',
			resource_id: resourceId,
		});
		return false;
	});
}

export async function persistUnchangedResourceResync(
	env: CoreEnv,
	resourceId: string,
	resource: ResourceForProcessing,
	paperEnrichment?: PaperMetadata | null,
): Promise<boolean> {
	if (!resource.platform_metadata) throw new Error(`Cannot resync resource ${resourceId} without platform metadata`);
	return withCoreTx(env, async (db) => {
		const lockedResource = await lockResourceState(db, resourceId);
		if (resourceWriteIsSuperseded(resource, lockedResource, 'unchanged_resync')) return false;
		const merged = mergeLockedResourceState(resource, lockedResource, paperEnrichment ?? null);
		const resourceWithDate = merged.resource;
		const previewImageUrl = resourceWithDate.og_image_url?.trim() || null;
		if (!resourceWithDate.platform_metadata) throw new Error(`Cannot resync resource ${resourceId} without platform metadata`);
		const platformMetadata = mergePaperEnrichment(resourceWithDate.platform_metadata, merged.paperEnrichment);
		const updated = await db
			.update(resources)
			.set({
				type: resourceWithDate.type,
				kind: resourceWithDate.kind,
				resourcePlatform: resourceWithDate.resource_platform,
				fileType: resourceWithDate.file_type ?? null,
				scrapedDate: new Date(),
				publishedDate: resourceWithDate.published_date ? new Date(resourceWithDate.published_date) : null,
				ogImageUrl: previewImageUrl,
				platformMetadata,
				updatedAt: new Date(),
			})
			.where(eq(resources.id, resourceId))
			.returning({ id: resources.id });
		if (!updated.length) throw new Error(`Failed to record resource ${resourceId} resync: not found`);
		return true;
	});
}

export async function persistAcademicMetadataBackfill(env: CoreEnv, resourceId: string, metadata: PaperMetadata): Promise<void> {
	await withCoreTx(env, async (_db, client) => {
		const locked = await client.query<{
			legacy_type: string;
			kind: string | null;
			resource_platform: string | null;
		}>(
			`
				SELECT type AS legacy_type, kind, resource_platform
				FROM resources
				WHERE id = $1::uuid
				FOR UPDATE
			`,
			[resourceId],
		);
		const row = locked.rows[0];
		if (!row) throw new Error(`Failed to persist academic metadata for resource ${resourceId}: not found`);
		const storedIdentity = parseResourceIdentity(row.kind, row.resource_platform);
		const currentIdentity =
			storedIdentity ??
			(row.kind === null && row.resource_platform === null && isResourceType(row.legacy_type)
				? legacyResourceIdentity(row.legacy_type)
				: null);
		if (!currentIdentity) {
			throw new Error(
				`Cannot persist academic metadata for resource ${resourceId} with invalid identity ${String(row.kind)} / ${String(row.resource_platform)}`,
			);
		}
		const identity = resourceIdentityWithAcademic(currentIdentity, true);
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
					kind = $4,
					resource_platform = $5,
					updated_at = NOW()
				WHERE id = $1::uuid
				RETURNING id::text AS id
			`,
			[resourceId, JSON.stringify(metadata), publishedDate, identity.kind, identity.resourcePlatform],
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

export async function persistResourceImageSnapshot(
	env: CoreEnv,
	resourceId: string,
	resource: ResourceForProcessing,
	paperEnrichment: PaperMetadata | null,
): Promise<boolean> {
	return withCoreTx(env, async (db) => {
		const lockedResource = await lockResourceState(db, resourceId);
		if (resourceWriteIsSuperseded(resource, lockedResource, 'acquisition_snapshot')) return false;
		const merged = mergeLockedResourceState(resource, lockedResource, paperEnrichment);
		if (!merged.resource.platform_metadata) {
			throw new Error(`Cannot snapshot resource ${resourceId} without platform metadata`);
		}
		const updated = await db
			.update(resources)
			.set({
				type: merged.resource.type,
				kind: merged.resource.kind,
				resourcePlatform: merged.resource.resource_platform,
				fileType: merged.resource.file_type ?? null,
				publishedDate: merged.resource.published_date ? new Date(merged.resource.published_date) : null,
				ogImageUrl: merged.resource.og_image_url?.trim() || null,
				platformMetadata: mergePaperEnrichment(merged.resource.platform_metadata, merged.paperEnrichment),
			})
			.where(eq(resources.id, resourceId))
			.returning({ id: resources.id });
		if (!updated.length) throw new Error(`Failed to persist resource ${resourceId} image snapshot: not found`);
		return true;
	});
}

export async function persistProcessedResource(
	env: CoreEnv,
	input: PersistProcessedResourceInput,
): Promise<{ persisted: boolean; resourceId: string }> {
	return withCoreTx(env, async (db) => {
		const lockedResource = await lockResourceState(db, input.resourceId);
		if (resourceWriteIsSuperseded(input.resource, lockedResource, 'processed_resource')) {
			return { persisted: false, resourceId: input.resourceId };
		}
		const { paperEnrichment, resource } = mergeLockedResourceState(input.resource, lockedResource, input.paperEnrichment);
		const extraction = input.pdfTextArtifact ? pdfExtractionMetadata(input.pdfTextArtifact) : input.acquisitionExtraction;
		const updatePayload = buildResourceUpdate(resource, {
			extraction,
			paperEnrichment,
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
		return { persisted: true, resourceId };
	});
}
