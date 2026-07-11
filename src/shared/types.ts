import type { ResourceCategory, ResourceScope, ResourceTranslationSource, ResourceType } from '@core-shared/resource-types';

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
	type: ResourceType;
	scope: ResourceScope;
	original_lang: string;
	title: string;
	summary: string | null;
	content: string | null;
	translations?: ResourceTranslationMap;
	url: string;
	og_image_url?: string | null;
	source: string;
	published_date: string;
	tags: string[];
	keywords: string[];
	platform_metadata?: PlatformMetadata;
	// Blob/private resource raw columns (undefined for source URL drafts).
	storage_key?: string | null;
	file_type?: string;
	normalized_source_url?: string | null;
	origin_type?: string;
}

export const ENTITY_TYPES = ['person', 'organization', 'product', 'technology', 'event', 'location'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export interface TranscriptSegment {
	startTime: number;
	endTime: number;
	text: string;
}

export interface YouTubeChapter {
	title: string;
	startTime: number;
	endTime: number;
}

export interface YoutubeTranscript {
	videoId: string;
	segments: TranscriptSegment[];
	language: string | null;
	chapters: YouTubeChapter[];
	chaptersFromDescription: boolean;
}

export interface NormalizedContent<T extends ResourceType = ResourceType> {
	type: T;
	title: string | null;
	/** Platform APIs return markdown or plain text for resource drafts. */
	markdown: string;
	metadata: {
		author: string | null;
		language: string | null;
		publishedDate: string | null;
		siteName: string | null;
		description: string | null;
	};
	platformMetadata?: PlatformMetadata<T>;
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
	variant?: 'shared' | 'longform';
	tweetId?: string;
	threadTweetCount?: number;
	media?: TwitterMedia[];
	createdAt?: string;
	quotedTweet?: QuotedTweetData;
	retweetedBy?: RetweetedByData;
	tweetText?: string;
	externalUrl?: string;
	externalOgImage?: string | null;
	externalTitle?: string | null;
	originalTweetUrl?: string;
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
	author: string;
	points: number;
	commentCount: number;
	itemType?: 'story' | 'ask' | 'show' | 'job';
	storyUrl?: string | null;
}

interface PdfMetadata {
	fileName: string;
	fileSize: number;
}

export interface PaperReference {
	openAlexId?: string;
	doi?: string;
	title?: string;
	year?: number;
	author?: string;
}

export interface PaperMetadata {
	source: 'openalex' | 'semanticscholar';
	/** Legacy field name; new values are source-native Semantic Scholar paperIds. */
	openAlexId?: string;
	doi?: string;
	arxivId?: string;
	title?: string;
	authors: string[];
	abstract?: string;
	venue?: string;
	year?: number;
	citedByCount?: number;
	referenceCount: number;
	oaPdfUrl?: string;
	landingPageUrl?: string;
	references: PaperReference[];
}

export interface PlatformEnrichments {
	hnUrl?: string;
	externalUrl?: string | null;
	hnText?: string | null;
	commentCount?: number;
	links?: string[];
	processedAt?: string;
}

interface ClassificationMetadata {
	category?: ResourceCategory;
	classifiedAt?: string;
}

interface ClassificationEnvelope {
	classification?: ClassificationMetadata | null;
}

interface OgImageDimensions {
	ogImageWidth?: number | null;
	ogImageHeight?: number | null;
}

export interface PlatformMetadataDataByResourceType {
	web: null;
	rss: null;
	twitter: TwitterMetadata;
	youtube: YouTubeMetadata;
	hackernews: HackerNewsMetadata;
	pdf: PdfMetadata;
	paper: PaperMetadata;
	image: null;
	file: null;
}

export interface PdfExtractionMetadata {
	status: 'ok' | 'needs_ocr';
	parser: 'liteparse';
	chars: number;
	pages: number;
}

export type PlatformMetadata<T extends ResourceType = ResourceType> = {
	fetchedAt: string;
	data: PlatformMetadataDataByResourceType[T];
	/** Hash of normalized source fields used to skip unchanged resync runs. */
	sourceSnapshotHash?: string;
	enrichments?: PlatformEnrichments | null;
	sourceName?: string;
	extraction?: PdfExtractionMetadata;
} & ClassificationEnvelope &
	OgImageDimensions;

export function platformMetadataFor<T extends ResourceType>(
	resource: Pick<ResourceForProcessing, 'type' | 'platform_metadata'>,
	type: T,
): PlatformMetadata<T> | null {
	return resource.type === type && resource.platform_metadata ? (resource.platform_metadata as PlatformMetadata<T>) : null;
}
