import type { ArticleCategory, PlatformMetadata } from './platform-metadata';

// Article related types
export interface Article {
	id: string;
	title: string;
	title_cn?: string | null;
	summary: string | null;
	summary_cn?: string | null;
	content: string | null;
	content_cn?: string | null;
	url: string;
	source: string;
	published_date: string;
	tags: string[];
	keywords: string[];
	source_type?: string;
	platform_metadata?: PlatformMetadata;
	// user_files-only raw columns (undefined for articles path).
	storage_key?: string | null;
	file_type?: string;
}

// AI Analysis result
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
	category?: ArticleCategory;
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
		ogImageUrl: string | null;
	};
	platformMetadata?: PlatformMetadata;
	youtubeTranscript?: YoutubeTranscript;
}
