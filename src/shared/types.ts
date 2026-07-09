import type { ResourceCategory, ResourceScope, ResourceType } from '../resources/types';

export interface ResourceForProcessing {
	id: string;
	type: ResourceType;
	scope: ResourceScope;
	title: string;
	title_cn?: string | null;
	summary: string | null;
	summary_cn?: string | null;
	content: string | null;
	content_cn?: string | null;
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

interface ExtractedEntity {
	name: string;
	name_cn: string;
	type: EntityType;
}

export interface AIAnalysisResult {
	tags?: string[];
	keywords?: string[];
	summary_en?: string;
	summary_cn?: string;
	content?: string;
	content_cn?: string;
	title_cn?: string;
	category?: ResourceCategory;
	entities?: ExtractedEntity[];
}

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

export interface NormalizedContent {
	title: string | null;
	/** Platform APIs return markdown or plain text for source article drafts. */
	markdown: string;
	metadata: {
		author: string | null;
		publishedDate: string | null;
		siteName: string | null;
		description: string | null;
	};
	platformMetadata?: PlatformMetadata;
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
	variant?: 'shared' | 'article';
	tweetId?: string;
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

export type PlatformMetadata =
	| ({ type: 'twitter'; fetchedAt: string; data: TwitterMetadata; enrichments?: PlatformEnrichments | null } & ClassificationEnvelope &
			OgImageDimensions)
	| ({ type: 'youtube'; fetchedAt: string; data: YouTubeMetadata; enrichments?: PlatformEnrichments | null } & ClassificationEnvelope &
			OgImageDimensions)
	| ({
			type: 'hackernews';
			fetchedAt: string;
			data: HackerNewsMetadata;
			enrichments?: PlatformEnrichments | null;
	  } & ClassificationEnvelope &
			OgImageDimensions)
	| ({ type: 'pdf'; fetchedAt: string; data: PdfMetadata; enrichments?: PlatformEnrichments | null } & ClassificationEnvelope &
			OgImageDimensions)
	| ({ type: 'paper'; fetchedAt: string; data: PaperMetadata; enrichments?: PlatformEnrichments | null } & ClassificationEnvelope &
			OgImageDimensions)
	| ({ type: 'default'; fetchedAt: string; data: null; enrichments?: PlatformEnrichments | null } & ClassificationEnvelope &
			OgImageDimensions);
