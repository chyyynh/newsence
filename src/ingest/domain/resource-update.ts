import { type ContentResourceType, canonicalizeOptionalResourceLang } from '@core-shared/resource-types';
import type { PaperMetadata, PlatformMetadata, ResourceForProcessing } from '@core-shared/types';
import { type AcquiredContent, type OgImagePatch, PDF_MIME, type PdfExtractionMetadata } from '../acquisition';
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

function canonicalPublishedDate(value: string | null): string | null {
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

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
	const acquiredTitle = acquired.title?.trim();
	return {
		...resource,
		title: acquiredTitle || resource.title,
		summary: acquired.metadata.description ?? resource.summary,
		content: acquired.markdown || resource.content,
		source: acquired.metadata.siteName ?? acquired.metadata.author ?? resource.source,
		original_lang: canonicalizeOptionalResourceLang(acquired.metadata.language) ?? resource.original_lang,
		published_date: canonicalPublishedDate(acquired.metadata.publishedDate) ?? resource.published_date,
		type: resourceTypeAfterAcquisition(resource.type, acquired.type),
		platform_metadata: mergePlatformMetadata(resource.platform_metadata, acquired.platformMetadata),
		file_type: acquired.type === 'pdf' ? PDF_MIME : resource.file_type,
	};
}

function resourceTypeAfterAcquisition(currentType: ContentResourceType, acquiredType: ContentResourceType): ContentResourceType {
	return acquiredType === 'web' && currentType !== 'web' ? currentType : acquiredType;
}

type BuildResourceUpdateInput = {
	processorResult?: ProcessorResult;
	extraction?: PdfExtractionMetadata;
	paperEnrichment?: PaperMetadata | null;
	ogImagePatch?: OgImagePatch;
};

export function buildResourceUpdate(resource: ResourceForProcessing, input: BuildResourceUpdateInput = {}): ResourceUpdate {
	const { processorResult, extraction, paperEnrichment, ogImagePatch } = input;
	const updateData: ProcessorResult['updateData'] = processorResult?.updateData ?? {};
	const metadataPatch: ResourceMetadataPatch = {};
	if (extraction) metadataPatch.extraction = extraction;
	if (ogImagePatch?.ogImageWidth && ogImagePatch.ogImageHeight) {
		metadataPatch.ogImageWidth = ogImagePatch.ogImageWidth;
		metadataPatch.ogImageHeight = ogImagePatch.ogImageHeight;
	}
	if (paperEnrichment) metadataPatch.data = paperEnrichment;

	let platformMetadata = resource.platform_metadata;
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
		type: paperEnrichment ? 'paper' : resource.type,
		title: resource.title,
		summary: updateData.summary !== undefined ? updateData.summary : resource.summary,
		content: updateData.content !== undefined ? updateData.content : resource.content,
		tags: [...(updateData.tags ?? resource.tags)],
		keywords: [...(updateData.keywords ?? resource.keywords)],
		entities: updateData.entities,
		og_image_url: ogImagePatch?.ogImageUrl || (resource.og_image_url ?? null),
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
