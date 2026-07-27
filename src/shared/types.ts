import type { ContentResourceType, ResourceCategory, ResourceScope, ResourceTranslationSource } from '@core-shared/resource-types';

export type ResourceLocaleText = {
	title?: string | null;
	summary?: string | null;
	content?: string | null;
	keywords?: string[] | null;
	source?: ResourceTranslationSource;
};

export type ResourceTranslationMap = Record<string, ResourceLocaleText | undefined>;

export interface ResourceForProcessing {
	id: string;
	source_id: string | null;
	type: ContentResourceType;
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
	file_type?: string;
	normalized_url?: string | null;
}

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

export interface YoutubeTranscript {
	videoId: string;
	segments: TranscriptSegment[];
	language: string | null;
	chapters: YouTubeChapter[];
	chaptersFromDescription: boolean;
}

export interface NormalizedContent<T extends ContentResourceType = ContentResourceType> {
	type: T;
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
}

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

interface PdfMetadata {
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
	/** Legacy first-author snapshot retained for tolerant readers. */
	author?: string;
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

export interface PlatformEnrichments {
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

interface PlatformMetadataDataByResourceType {
	web: null;
	rss: null;
	twitter: TwitterMetadata;
	youtube: YouTubeMetadata;
	hackernews: HackerNewsMetadata;
	pdf: PdfMetadata;
}

export interface PdfExtractionMetadata {
	status: 'ok' | 'needs_ocr';
	parser: 'liteparse';
	chars: number;
	pages: number;
}

export type PlatformMetadata<T extends ContentResourceType = ContentResourceType> = {
	fetchedAt: string;
	data: PlatformMetadataDataByResourceType[T];
	/** Hash of normalized source fields used to skip unchanged resync runs. */
	sourceSnapshotHash?: string;
	enrichments?: PlatformEnrichments | null;
	sourceName?: string;
	extraction?: PdfExtractionMetadata;
} & ClassificationEnvelope;

export function platformMetadataFor<T extends ContentResourceType>(
	resource: Pick<ResourceForProcessing, 'type' | 'platform_metadata'>,
	type: T,
): PlatformMetadata<T> | null {
	return resource.type === type && resource.platform_metadata ? (resource.platform_metadata as PlatformMetadata<T>) : null;
}
