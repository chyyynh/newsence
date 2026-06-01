// ─────────────────────────────────────────────────────────────
// Canonical Platform Metadata Types + Builder
//
// MIRROR OF frontend/src/types/platform-metadata.ts. The worker WRITES
// platform_metadata (articles) / metadata (user_files) JSONB; the frontend
// READS it — both PlatformMetadata unions must describe the SAME JSON. Separate
// pnpm workspaces can't share a module, so keep these shapes identical by hand:
// change one, change the other.
// ─────────────────────────────────────────────────────────────

import type { HackerNewsMetadata } from '@ingest/platforms/hackernews/metadata';
import type { TwitterMetadata } from '@ingest/platforms/twitter/metadata';
import type { YouTubeMetadata } from '@ingest/platforms/youtube/metadata';

export type { HackerNewsMetadata } from '@ingest/platforms/hackernews/metadata';
export type { QuotedTweetData, TwitterAuthorFields, TwitterMedia, TwitterMetadata } from '@ingest/platforms/twitter/metadata';
export type { YouTubeMetadata } from '@ingest/platforms/youtube/metadata';

/** PDF upload metadata (stored in `user_files.metadata`). */
export interface PdfMetadata {
	fileName: string;
	fileSize: number;
	pdfUrl: string;
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
