import type {
	ContentResourceIdentity,
	ResourceCategory,
	ResourceIdentityColumns,
	ResourcePlatform,
	ResourceScope,
	ResourceTranslationSource,
	SourceAcquisitionMode,
} from '@core-shared/resource-types';

export type ResourceLocaleText = {
	title?: string | null;
	summary?: string | null;
	content?: string | null;
	keywords?: string[] | null;
	source?: ResourceTranslationSource;
};

export type ResourceTranslationMap = Record<string, ResourceLocaleText | undefined>;

type ResourceForProcessingBase = {
	id: string;
	source_id: string | null;
	source_acquisition_mode?: SourceAcquisitionMode | null;
	scope: ResourceScope;
	original_lang: string;
	title: string;
	summary: string | null;
	content: string | null;
	translations: ResourceTranslationMap;
	url: string | null;
	og_image_url?: string | null;
	source: string | null;
	published_date: string | null;
	tags: string[];
	keywords: string[];
	platform_metadata?: PlatformMetadata;
	// Blob/private resource raw columns (undefined for source URL drafts).
	storage_key?: string | null;
	file_type?: string | null;
	normalized_url?: string | null;
};

export type ResourceForProcessing = ResourceForProcessingBase & ResourceIdentityColumns;

export const ENTITY_TYPES = ['person', 'organization', 'product', 'technology', 'event', 'location'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/**
 * One resource-local entity annotation stored on `resources.entities`. Keys
 * are short because every enriched resource can carry several of these.
 *
 * `k` is stable enough for a future consumer to group exact canonical matches;
 * `n`/`cn` are display labels and `t` is the entity class.
 */
export type StoredResourceEntity = {
	k: string;
	n: string;
	cn: string | null;
	t: EntityType;
};

export interface TranscriptSegment {
	startTime: number;
	endTime: number;
	text: string;
}

export interface YouTubeChapter {
	title: string;
	startTime: number;
	endTime?: number;
}

interface YouTubeHighlight {
	title: string;
	summary: string;
	startTime: number;
	endTime: number;
}

export interface YouTubeHighlights {
	version: '1.0';
	model: string;
	highlights: YouTubeHighlight[];
	generatedAt: string;
}

export interface YoutubeTranscript {
	videoId: string;
	segments: TranscriptSegment[];
	language: string | null;
	chapters: YouTubeChapter[];
	chaptersFromDescription: boolean;
}

type NormalizedContentBase<T extends ResourcePlatform> = {
	fileType: string | null;
	title: string;
	/** Platform APIs return markdown or plain text for resource drafts. */
	markdown: string;
	/** Canonical preview image selected by the acquisition source. */
	previewImageUrl?: string | null;
	metadata: {
		author: string | null;
		language: string | null;
		publishedDate: string | null;
		siteName: string;
		description: string | null;
	};
	platformMetadata: PlatformMetadata<T>;
	youtubeTranscript?: YoutubeTranscript;
};

export type NormalizedContent<T extends ResourcePlatform = ResourcePlatform> = NormalizedContentBase<T> &
	Extract<ContentResourceIdentity, { resourcePlatform: T }>;

export interface TwitterMedia {
	url: string;
	type: 'photo' | 'video' | 'animated_gif';
	videoUrl?: string;
	width?: number;
	height?: number;
}

export interface TwitterAuthorFields {
	authorName: string;
	authorUserName: string;
	authorProfilePicture?: string;
	authorVerified?: boolean;
}

export interface QuotedTweetData {
	authorName: string;
	authorUserName: string;
	authorProfilePicture?: string;
	text: string;
}

export interface RetweetedByData {
	tweetId?: string;
	tweetUrl?: string;
	retweetedAt?: string;
	authorName: string;
	authorUserName: string;
	authorProfilePicture?: string;
	authorVerified?: boolean;
}

interface TwitterMetadata extends TwitterAuthorFields {
	tweetId?: string;
	coverImageUrl?: string;
	media?: TwitterMedia[];
	createdAt?: string;
	quotedTweet?: QuotedTweetData;
	externalUrl?: string;
	externalOgImage?: string | null;
	externalTitle?: string | null;
}

interface YouTubeMetadata {
	videoId: string;
	channelName: string;
	channelId?: string;
	channelAvatar?: string;
	duration?: string;
	thumbnailUrl?: string;
	viewCount?: number;
	likeCount?: number;
	commentCount?: number;
	publishedAt?: string;
	description?: string;
	tags?: string[];
}

export interface HackerNewsMetadata {
	itemId: string;
	author?: string;
	points?: number;
	commentCount?: number;
	itemType?: 'story' | 'ask' | 'show' | 'job';
	storyUrl?: string | null;
}

interface ResourceRepresentationMetadata {
	fileName: string;
	fileSize: number;
}

export interface PaperReference {
	paperId?: string;
	doi?: string;
	url?: string;
	title?: string;
	year?: number;
	authors?: string[];
}

export interface PaperMetadata {
	schemaVersion: 2;
	source: 'semanticscholar';
	resolvedAt: string;
	metricsUpdatedAt: string;
	doi?: string;
	title?: string;
	authors: string[];
	abstract?: string;
	venue?: string;
	year?: number;
	publicationDate?: string;
	publicationTypes?: string[];
	citedByCount?: number;
	referenceCount?: number;
	pdfUrl?: string;
	references: PaperReference[];
	referencesTruncated: boolean;
}

interface PlatformEnrichments {
	academic?: PaperMetadata | null;
	links?: string[];
}

interface ClassificationMetadata {
	category?: ResourceCategory;
	classifiedAt?: string;
}

interface ClassificationEnvelope {
	classification?: ClassificationMetadata | null;
}

interface PlatformMetadataDataByResourcePlatform {
	twitter: TwitterMetadata;
	youtube: YouTubeMetadata;
	hackernews: HackerNewsMetadata;
}

export interface PdfExtractionMetadata {
	status: 'ok' | 'needs_ocr';
	parser: 'liteparse';
	chars: number;
	pages: number;
}

type PlatformMetadataData<T extends ResourcePlatform> = T extends keyof PlatformMetadataDataByResourcePlatform
	? PlatformMetadataDataByResourcePlatform[T]
	: null;

export type PlatformMetadata<T extends ResourcePlatform = ResourcePlatform> = {
	fetchedAt: string;
	data: PlatformMetadataData<T>;
	/** Hash of normalized source fields used to skip unchanged resync runs. */
	sourceSnapshotHash?: string;
	enrichments?: PlatformEnrichments | null;
	sourceName?: string;
	/** Primary file representation facts; MIME and blob identity stay scalar. */
	representation?: ResourceRepresentationMetadata;
	extraction?: PdfExtractionMetadata;
} & ClassificationEnvelope;

export function withPdfExtractionMetadata<T extends ResourcePlatform>(
	platformMetadata: PlatformMetadata<T>,
	extraction: PdfExtractionMetadata | undefined,
): PlatformMetadata<T> {
	return extraction ? { ...platformMetadata, extraction } : platformMetadata;
}

export function platformMetadataFor<T extends Exclude<ResourcePlatform, null>>(
	resource: Pick<ResourceForProcessing, 'resource_platform' | 'platform_metadata'>,
	resourcePlatform: T,
): PlatformMetadata<T> | null {
	return resource.resource_platform === resourcePlatform && resource.platform_metadata
		? (resource.platform_metadata as PlatformMetadata<T>)
		: null;
}
