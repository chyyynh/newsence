import type { ContentResourceType } from '@core-shared/resource-types';
import type { PaperMetadata, PlatformMetadata, ResourceForProcessing } from '@core-shared/types';
import { type AcquiredContent, PDF_MIME, type PdfExtractionMetadata } from '../acquisition';
import type { ProcessorResult } from './ai-utils';

export type ResourceUpdate = {
	type: ContentResourceType;
	title: string;
	summary: string | null;
	content: string | null;
	tags: string[];
	keywords: string[];
	entities: ProcessorResult['updateData']['entities'];
	og_image_url: string | null;
	platform_metadata: PlatformMetadata | undefined;
};

type ResourceMetadataPatch = Record<string, unknown>;

function metadataRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function mergePlatformMetadata(current: unknown, incoming: unknown): PlatformMetadata | undefined {
	const currentRecord = metadataRecord(current);
	const incomingRecord = metadataRecord(incoming);
	if (!currentRecord && !incomingRecord) return undefined;
	const merged = { ...currentRecord, ...incomingRecord };
	return {
		...merged,
		fetchedAt: typeof merged.fetchedAt === 'string' ? merged.fetchedAt : new Date().toISOString(),
		data: ('data' in merged ? merged.data : null) as PlatformMetadata['data'],
	};
}

export function applyAcquiredContent(resource: ResourceForProcessing, acquired?: AcquiredContent): ResourceForProcessing {
	if (!acquired) return resource;
	return {
		...resource,
		title: acquired.title.trim(),
		summary: acquired.metadata.description,
		content: acquired.markdown,
		source: acquired.metadata.siteName,
		type: resourceTypeAfterAcquisition(resource.type, acquired.type),
		platform_metadata: mergePlatformMetadata(resource.platform_metadata, acquired.platformMetadata),
		file_type: acquired.type === 'pdf' || acquired.extraction ? PDF_MIME : resource.file_type,
	};
}

function resourceTypeAfterAcquisition(currentType: ContentResourceType, acquiredType: ContentResourceType): ContentResourceType {
	return acquiredType === 'web' && currentType !== 'web' ? currentType : acquiredType;
}

type BuildResourceUpdateInput = {
	processorResult?: ProcessorResult;
	extraction?: PdfExtractionMetadata;
	paperEnrichment?: PaperMetadata | null;
	previewImageUrl: string | null;
};

export function buildResourceUpdate(resource: ResourceForProcessing, input: BuildResourceUpdateInput): ResourceUpdate {
	const { processorResult, extraction, paperEnrichment, previewImageUrl } = input;
	const updateData: ProcessorResult['updateData'] = processorResult?.updateData ?? {};
	const metadataPatch: ResourceMetadataPatch = {};
	if (extraction) metadataPatch.extraction = extraction;
	let platformMetadata = resource.platform_metadata;
	if (paperEnrichment) {
		const base = platformMetadata ?? { fetchedAt: new Date().toISOString(), data: null };
		platformMetadata = {
			...base,
			enrichments: { ...(base.enrichments || {}), academic: paperEnrichment },
		};
	}
	if (processorResult?.enrichments && Object.keys(processorResult.enrichments).length) {
		const base = platformMetadata ?? { fetchedAt: new Date().toISOString(), data: null };
		platformMetadata = {
			...base,
			enrichments: { ...(base.enrichments || {}), ...processorResult.enrichments, processedAt: new Date().toISOString() },
		};
	}
	if (processorResult?.classificationCategory) {
		const base = platformMetadata ?? { fetchedAt: new Date().toISOString(), data: null };
		platformMetadata = {
			...base,
			classification: {
				...(base.classification ?? {}),
				category: processorResult.classificationCategory,
				classifiedAt: new Date().toISOString(),
			},
		};
	}
	platformMetadata = platformMetadataWithSourceName(
		mergePlatformMetadata(platformMetadata, Object.keys(metadataPatch).length ? metadataPatch : undefined),
		resource.source,
	);

	return {
		type: resource.type,
		title: resource.title,
		summary: updateData.summary !== undefined ? updateData.summary : resource.summary,
		content: updateData.content !== undefined ? updateData.content : resource.content,
		tags: [...(updateData.tags ?? resource.tags)],
		keywords: [...(updateData.keywords ?? resource.keywords)],
		entities: updateData.entities,
		og_image_url: previewImageUrl?.trim() || null,
		platform_metadata: platformMetadata,
	};
}

function platformMetadataWithSourceName(
	platformMetadata: PlatformMetadata | undefined,
	source: string | null | undefined,
): PlatformMetadata | undefined {
	const sourceName = source?.trim();
	if (!sourceName) return platformMetadata;
	return platformMetadata ? { ...platformMetadata, sourceName } : { fetchedAt: new Date().toISOString(), data: null, sourceName };
}
