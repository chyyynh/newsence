import type { Article, PaperMetadata, PlatformMetadata } from '@core-shared/types';
import { type AcquiredContent, type OgImagePatch, PDF_MIME } from '../acquisition';
import type { ProcessorResult } from './ai-utils';

type ResourceUpdate = Partial<ProcessorResult['updateData']> &
	Partial<{
		title: string;
		source: string;
		published_date: string;
		resource_type: string;
		content: string;
		og_image_url: string;
		platform_metadata: PlatformMetadata | Record<string, unknown>;
		embedding: string;
	}>;

type ResourceMetadataPatch = Record<string, unknown>;

export function applyAcquiredContent(article: Article, acquired: AcquiredContent | null): Article {
	if (!acquired) return article;
	const acquiredTitle = acquired.title?.trim();
	const acquiredSourceType = acquired.platformMetadata?.type;
	return {
		...article,
		title: acquiredTitle || article.title,
		summary: acquired.metadata.description ?? article.summary,
		content: acquired.markdown || article.content,
		source: acquired.metadata.siteName ?? acquired.metadata.author ?? article.source,
		published_date: acquired.metadata.publishedDate ?? article.published_date,
		resource_type: resourceTypeAfterAcquisition(article.resource_type, acquiredSourceType),
		platform_metadata: acquired.platformMetadata ?? article.platform_metadata,
		file_type: acquired.platformMetadata?.type === 'pdf' ? PDF_MIME : article.file_type,
	};
}

function resourceTypeAfterAcquisition(currentType: string | undefined, acquiredType: string | undefined): string | undefined {
	return currentType === 'rss' && acquiredType === 'default' ? currentType : (acquiredType ?? currentType);
}

export class ResourceUpdateBuilder {
	private readonly update: ResourceUpdate = {};
	private readonly metadataPatches: ResourceMetadataPatch[] = [];

	constructor(private readonly article: Article) {}

	addAcquiredMetadata(acquired: AcquiredContent | null): this {
		return this.addMetadataPatch(acquired?.platformMetadata);
	}

	addExtractionMetadata(extraction: AcquiredContent['extraction'] | undefined): this {
		return extraction ? this.addMetadataPatch({ extraction }) : this;
	}

	addOgMetadata(patch: OgImagePatch): this {
		return patch.ogImageWidth && patch.ogImageHeight
			? this.addMetadataPatch({ ogImageWidth: patch.ogImageWidth, ogImageHeight: patch.ogImageHeight })
			: this;
	}

	addPaperMetadata(paperEnrichment: PaperMetadata | null): this {
		return paperEnrichment ? this.addMetadataPatch({ type: 'paper', data: paperEnrichment }) : this;
	}

	applyAcquiredFields(acquired: AcquiredContent | null): this {
		if (!acquired) return this;
		const acquiredTitle = acquired.title?.trim();
		if (acquiredTitle) this.update.title = acquiredTitle;
		if (acquired.metadata.siteName || acquired.metadata.author)
			this.update.source = acquired.metadata.siteName ?? acquired.metadata.author ?? '';
		if (acquired.metadata.publishedDate) this.update.published_date = acquired.metadata.publishedDate;
		if (acquired.metadata.description !== null) this.update.summary = acquired.metadata.description;
		this.update.content = acquired.markdown;
		if (acquired.platformMetadata)
			this.update.resource_type = resourceTypeAfterAcquisition(this.article.resource_type, acquired.platformMetadata.type);
		return this;
	}

	applyProcessorResult(result: ProcessorResult, embedding?: number[] | null): this {
		Object.assign(this.update, result.updateData);
		const category = result.classificationCategory;
		const hasEnrichments = !!result.enrichments && Object.keys(result.enrichments).length > 0;
		let mergedMetadata: PlatformMetadata | null = this.article.platform_metadata ?? null;
		if (hasEnrichments && mergedMetadata) {
			mergedMetadata = {
				...mergedMetadata,
				enrichments: { ...(mergedMetadata.enrichments || {}), ...result.enrichments, processedAt: new Date().toISOString() },
			};
		}
		if (category) {
			const base = mergedMetadata ??
				this.article.platform_metadata ?? { type: 'default' as const, fetchedAt: new Date().toISOString(), data: null };
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
		if (metadataPatch) this.update.platform_metadata = { ...(mergedMetadata ?? this.article.platform_metadata ?? {}), ...metadataPatch };
		else if (mergedMetadata) this.update.platform_metadata = mergedMetadata;
		if (embedding?.length) this.update.embedding = `[${embedding.join(',')}]`;
		return this;
	}

	applyOgFields(patch: OgImagePatch): this {
		if (patch.ogImageUrl) this.update.og_image_url = patch.ogImageUrl;
		return this;
	}

	build(): Record<string, unknown> {
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
