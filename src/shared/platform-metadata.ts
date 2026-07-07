// ─────────────────────────────────────────────────────────────
// Canonical Platform Metadata Types
//
// The worker writes persisted platform_metadata (articles) / metadata
// (user_files) JSONB. Keep this envelope stable for app-worker reads; UI-only
// projections should be derived there instead of written back to the DB.
// ─────────────────────────────────────────────────────────────

// ── Twitter ──────────────────────────────────────────────────

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

/**
 * Flat persisted Twitter shape. `variant` discriminates standard (omitted),
 * `'shared'` (external link — adds tweetText/externalUrl/externalOgImage/externalTitle),
 * and `'article'` (long-form — author only).
 */
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

// ── YouTube ──────────────────────────────────────────────────

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

// ── HackerNews ───────────────────────────────────────────────

export interface HackerNewsMetadata {
	itemId: string;
	author: string;
	points: number;
	commentCount: number;
	itemType?: 'story' | 'ask' | 'show' | 'job';
	storyUrl?: string | null;
}

// ── PDF ──────────────────────────────────────────────────────

/**
 * PDF upload metadata (stored in `user_files.metadata`). Descriptive fields only
 * — the fetch URL is NOT stored. The asset lives at `storage_key` (the
 * authoritative column); the URL is derived from it at read time, so renaming
 * the asset route never rots persisted data.
 */
interface PdfMetadata {
	fileName: string;
	fileSize: number;
}

// ── Academic paper ───────────────────────────────────────────

/**
 * A single resolved reference of a paper. `openAlexId` is the legacy DB-facing
 * field name; new enrichments store the source-native Semantic Scholar paperId.
 */
export interface PaperReference {
	openAlexId?: string;
	doi?: string;
	title?: string;
	year?: number;
	author?: string;
}

/**
 * Academic-paper metadata (stored in the `paper` envelope). Sourced from
 * Semantic Scholar via a DOI or arXiv id. `references` is capped and best-effort;
 * `referenceCount` is the true count even when the list is truncated or the
 * reference resolve failed.
 */
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

// ─────────────────────────────────────────────────────────────
// Enrichments
// ─────────────────────────────────────────────────────────────

export interface PlatformEnrichments {
	hnUrl?: string;
	externalUrl?: string | null;
	hnText?: string | null;
	commentCount?: number;
	links?: string[];
	processedAt?: string;
}

// ─────────────────────────────────────────────────────────────
// Top-level envelope (discriminated union)
// ─────────────────────────────────────────────────────────────

export type ArticleCategory = 'AI' | 'Tech' | 'Finance' | 'Research' | 'Business' | 'Other';

interface ClassificationMetadata {
	category?: ArticleCategory;
	classifiedAt?: string;
}

interface ClassificationEnvelope {
	classification?: ClassificationMetadata | null;
}

export type PlatformMetadata =
	| ({ type: 'twitter'; fetchedAt: string; data: TwitterMetadata; enrichments?: PlatformEnrichments | null } & ClassificationEnvelope)
	| ({ type: 'youtube'; fetchedAt: string; data: YouTubeMetadata; enrichments?: PlatformEnrichments | null } & ClassificationEnvelope)
	| ({ type: 'hackernews'; fetchedAt: string; data: HackerNewsMetadata; enrichments?: PlatformEnrichments | null } & ClassificationEnvelope)
	| ({ type: 'pdf'; fetchedAt: string; data: PdfMetadata; enrichments?: PlatformEnrichments | null } & ClassificationEnvelope)
	| ({ type: 'paper'; fetchedAt: string; data: PaperMetadata; enrichments?: PlatformEnrichments | null } & ClassificationEnvelope)
	| ({ type: 'default'; fetchedAt: string; data: null; enrichments?: PlatformEnrichments | null } & ClassificationEnvelope);
