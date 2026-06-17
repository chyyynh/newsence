// ─────────────────────────────────────────────────────────────
// Canonical Platform Metadata Types + Builder
//
// MIRROR OF frontend/src/types/platform-metadata.ts. The worker WRITES
// platform_metadata (articles) / metadata (user_files) JSONB; the frontend
// READS it — both PlatformMetadata unions must describe the SAME JSON. Separate
// pnpm workspaces can't share a module, so keep these shapes identical by hand:
// change one, change the other.
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
}

export interface QuotedTweetData {
	authorName: string;
	authorUserName: string;
	authorProfilePicture?: string;
	text: string;
}

/**
 * Flat shape (mirrors the frontend). `variant` discriminates standard (omitted),
 * `'shared'` (external link — adds tweetText/externalUrl/externalOgImage/externalTitle),
 * and `'article'` (long-form — author only). Constructed via `buildMetadata('twitter', …)`.
 */
export interface TwitterMetadata extends TwitterAuthorFields {
	variant?: 'shared' | 'article';
	media?: TwitterMedia[];
	createdAt?: string;
	quotedTweet?: QuotedTweetData;
	tweetText?: string;
	externalUrl?: string;
	externalOgImage?: string | null;
	externalTitle?: string | null;
}

// ── YouTube ──────────────────────────────────────────────────

export interface YouTubeMetadata {
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
export interface PdfMetadata {
	fileName: string;
	fileSize: number;
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

/** Optional OG image dimensions stored at the envelope level (cross-platform). */
export interface OgImageDimensions {
	ogImageWidth?: number | null;
	ogImageHeight?: number | null;
}

/** True when an envelope already carries usable (positive) OG image dimensions. */
export function hasOgDimensions(metadata: PlatformMetadata | null | undefined): boolean {
	return !!metadata && !!metadata.ogImageWidth && !!metadata.ogImageHeight;
}

/**
 * Attach OG image dimensions to an envelope, synthesizing a `default` envelope
 * when the article has none yet (mirrors rss/monitor's dims-only envelope, so an
 * article that was stored with `platform_metadata = null` still gets boxable
 * dims). Used by both the processing workflow and the backfill endpoint.
 */
export function withOgDimensions(metadata: PlatformMetadata | null | undefined, width: number, height: number): PlatformMetadata {
	const base: PlatformMetadata = metadata ?? { type: 'default', fetchedAt: new Date().toISOString(), data: null };
	return { ...base, ogImageWidth: width, ogImageHeight: height };
}

export type PlatformMetadata =
	| ({ type: 'twitter'; fetchedAt: string; data: TwitterMetadata; enrichments?: PlatformEnrichments | null } & OgImageDimensions)
	| ({ type: 'youtube'; fetchedAt: string; data: YouTubeMetadata; enrichments?: PlatformEnrichments | null } & OgImageDimensions)
	| ({ type: 'hackernews'; fetchedAt: string; data: HackerNewsMetadata; enrichments?: PlatformEnrichments | null } & OgImageDimensions)
	| ({ type: 'pdf'; fetchedAt: string; data: PdfMetadata; enrichments?: PlatformEnrichments | null } & OgImageDimensions)
	| ({ type: 'default'; fetchedAt: string; data: null; enrichments?: PlatformEnrichments | null } & OgImageDimensions);

// ─────────────────────────────────────────────────────────────
// Generic envelope builder
// ─────────────────────────────────────────────────────────────

/** Maps each platform `type` to the shape of its `data` payload. */
interface MetadataDataMap {
	twitter: TwitterMetadata;
	youtube: YouTubeMetadata;
	hackernews: HackerNewsMetadata;
	pdf: PdfMetadata;
	default: null;
}

/**
 * Wraps an already-assembled `data` payload in the platform envelope, binding the
 * `type` literal to the correct `data` shape via {@link MetadataDataMap}. Replaces the
 * per-platform `buildX` constructors (which were identical except for the `type` string).
 */
export function buildMetadata<T extends keyof MetadataDataMap>(type: T, data: MetadataDataMap[T]): Extract<PlatformMetadata, { type: T }> {
	return { type, fetchedAt: new Date().toISOString(), data } as Extract<PlatformMetadata, { type: T }>;
}
