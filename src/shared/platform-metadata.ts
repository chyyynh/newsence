// ─────────────────────────────────────────────────────────────
// Canonical Platform Metadata Types + Builders
// ─────────────────────────────────────────────────────────────

import type { BilibiliMetadata } from '@ingest/platforms/bilibili/metadata';
import type { HackerNewsMetadata } from '@ingest/platforms/hackernews/metadata';
import type { TwitterMetadata } from '@ingest/platforms/twitter/metadata';
import type { XiaohongshuMetadata } from '@ingest/platforms/xiaohongshu/metadata';
import type { YouTubeMetadata } from '@ingest/platforms/youtube/metadata';

export type { BilibiliMetadata } from '@ingest/platforms/bilibili/metadata';
export type { HackerNewsMetadata } from '@ingest/platforms/hackernews/metadata';
// Re-exports
export {
	buildTwitterArticle,
	buildTwitterShared,
	buildTwitterStandard,
	type QuotedTweetData,
	type TwitterAuthorFields,
	type TwitterMedia,
	type TwitterMetadata,
} from '@ingest/platforms/twitter/metadata';
export type { XiaohongshuMetadata } from '@ingest/platforms/xiaohongshu/metadata';
export type { YouTubeMetadata } from '@ingest/platforms/youtube/metadata';

// ─────────────────────────────────────────────────────────────
// Source types
// ─────────────────────────────────────────────────────────────

export type SourceType = 'twitter' | 'youtube' | 'hackernews' | 'bilibili' | 'xiaohongshu' | 'default';

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

export type PlatformMetadata =
	| ({ type: 'twitter'; fetchedAt: string; data: TwitterMetadata; enrichments?: PlatformEnrichments | null } & OgImageDimensions)
	| ({ type: 'youtube'; fetchedAt: string; data: YouTubeMetadata; enrichments?: PlatformEnrichments | null } & OgImageDimensions)
	| ({ type: 'hackernews'; fetchedAt: string; data: HackerNewsMetadata; enrichments?: PlatformEnrichments | null } & OgImageDimensions)
	| ({ type: 'bilibili'; fetchedAt: string; data: BilibiliMetadata; enrichments?: PlatformEnrichments | null } & OgImageDimensions)
	| ({ type: 'xiaohongshu'; fetchedAt: string; data: XiaohongshuMetadata; enrichments?: PlatformEnrichments | null } & OgImageDimensions)
	| ({ type: 'default'; fetchedAt: string; data: null; enrichments?: PlatformEnrichments | null } & OgImageDimensions);

// ─────────────────────────────────────────────────────────────
// Generic envelope builder
// ─────────────────────────────────────────────────────────────

/** Maps each platform `type` to the shape of its `data` payload. */
interface MetadataDataMap {
	twitter: TwitterMetadata;
	youtube: YouTubeMetadata;
	hackernews: HackerNewsMetadata;
	bilibili: BilibiliMetadata;
	xiaohongshu: XiaohongshuMetadata;
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
