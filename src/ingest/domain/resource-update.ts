import type { PaperMetadata, PlatformMetadata, ResourceForProcessing } from '@core-shared/types';
import { canonicalizeOptionalResourceLang, type ResourceType } from '../../resources/types';
import { type AcquiredContent, type OgImagePatch, PDF_MIME, type PdfExtractionMetadata } from '../acquisition';
import type { ProcessorResult } from './ai-utils';

export type ResourceUpdate = ProcessorResult['updateData'] &
	Partial<{
		type: ResourceType;
		og_image_url: string;
		platform_metadata: PlatformMetadata | Record<string, unknown>;
		embedding: string;
	}>;

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

function resourceTypeAfterAcquisition(currentType: ResourceType, acquiredType: ResourceType): ResourceType {
	return acquiredType === 'web' && currentType !== 'web' ? currentType : acquiredType;
}

export class ResourceUpdateBuilder {
	private readonly update: ResourceUpdate = {};
	private readonly metadataPatches: ResourceMetadataPatch[] = [];

	constructor(private readonly resource: ResourceForProcessing) {}

	addExtractionMetadata(extraction: PdfExtractionMetadata | undefined): this {
		return extraction ? this.addMetadataPatch({ extraction }) : this;
	}

	addOgMetadata(patch: OgImagePatch): this {
		return patch.ogImageWidth && patch.ogImageHeight
			? this.addMetadataPatch({ ogImageWidth: patch.ogImageWidth, ogImageHeight: patch.ogImageHeight })
			: this;
	}

	addPaperMetadata(paperEnrichment: PaperMetadata | null): this {
		if (!paperEnrichment) return this;
		this.update.type = 'paper';
		return this.addMetadataPatch({ data: paperEnrichment });
	}

	applyProcessorResult(result: ProcessorResult, embedding?: number[] | null): this {
		Object.assign(this.update, result.updateData);
		const category = result.classificationCategory;
		const hasEnrichments = !!result.enrichments && Object.keys(result.enrichments).length > 0;
		let mergedMetadata: PlatformMetadata | null = this.resource.platform_metadata ?? null;
		if (hasEnrichments && mergedMetadata) {
			mergedMetadata = {
				...mergedMetadata,
				enrichments: { ...(mergedMetadata.enrichments || {}), ...result.enrichments, processedAt: new Date().toISOString() },
			};
		}
		if (category) {
			const base = mergedMetadata ?? this.resource.platform_metadata ?? { fetchedAt: new Date().toISOString(), data: null };
			mergedMetadata = {
				...base,
				classification: {
					...(base.classification ?? {}),
					category,
					classifiedAt: new Date().toISOString(),
				},
			};
		}

		const metadataPatch = this.mergedMetadataPatch();
		if (metadataPatch) this.update.platform_metadata = { ...(mergedMetadata ?? this.resource.platform_metadata ?? {}), ...metadataPatch };
		else if (mergedMetadata) this.update.platform_metadata = mergedMetadata;
		if (embedding?.length) this.update.embedding = `[${embedding.join(',')}]`;
		return this;
	}

	applyOgFields(patch: OgImagePatch): this {
		if (patch.ogImageUrl) this.update.og_image_url = patch.ogImageUrl;
		return this;
	}

	build(): ResourceUpdate {
		return { ...this.update };
	}

	private addMetadataPatch(patch: unknown): this {
		if (patch && typeof patch === 'object' && !Array.isArray(patch)) this.metadataPatches.push(patch as ResourceMetadataPatch);
		return this;
	}

	private mergedMetadataPatch(): ResourceMetadataPatch | undefined {
		return this.metadataPatches.length ? Object.assign({}, ...this.metadataPatches) : undefined;
	}
}
