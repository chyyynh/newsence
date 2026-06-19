// ─────────────────────────────────────────────────────────────
// Canonical Platform Metadata Types + Builder
//
// The worker WRITES platform_metadata (articles) / metadata (user_files) JSONB;
// the frontend READS it via frontend/src/types/platform-metadata.ts. Keep the
// persisted envelope + per-platform data shapes compatible. Frontend may add
// projection-only fields (for example derived URLs), but those must not be
// written back to the DB.
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
 * Flat shape (mirrors the frontend). `variant` discriminates standard (omitted),
 * `'shared'` (external link — adds tweetText/externalUrl/externalOgImage/externalTitle),
 * and `'article'` (long-form — author only). Constructed via `buildMetadata('twitter', …)`.
 */
export interface TwitterMetadata extends TwitterAuthorFields {
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

type PlatformInputType = 'youtube' | 'twitter' | 'hackernews' | 'default';
type HackerNewsItemType = 'story' | 'ask' | 'show' | 'job';
type TwitterVariant = 'shared' | 'article';
type TwitterMediaType = TwitterMedia['type'];

const HACKERNEWS_ITEM_TYPES: readonly HackerNewsItemType[] = ['story', 'ask', 'show', 'job'];
const TWITTER_VARIANTS: readonly TwitterVariant[] = ['shared', 'article'];
const TWITTER_MEDIA_TYPES: readonly TwitterMediaType[] = ['photo', 'video', 'animated_gif'];

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asNullableString(value: unknown): string | null | undefined {
	if (value === null) return null;
	return asString(value);
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value !== 'string' || value.trim().length === 0) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === 'boolean' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const strings = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
	return strings.length > 0 ? strings : undefined;
}

function asPlatformType(value: unknown, fallbackType: string): PlatformInputType {
	const type = asString(value) ?? fallbackType;
	if (type === 'youtube' || type === 'twitter' || type === 'hackernews') return type;
	return 'default';
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
	const str = asString(value);
	return allowed.find((candidate) => candidate === str);
}

function parseTwitterMediaItem(value: unknown): TwitterMedia | null {
	const item = asRecord(value);
	if (!item) return null;
	const url = asString(item.url);
	const type = asEnum(item.type, TWITTER_MEDIA_TYPES);
	if (!url || !type) return null;
	return {
		url,
		type,
		videoUrl: asString(item.videoUrl),
		width: asNumber(item.width),
		height: asNumber(item.height),
	};
}

function asTwitterMediaArray(value: unknown): TwitterMedia[] {
	if (!Array.isArray(value)) return [];
	return value.map(parseTwitterMediaItem).filter((item): item is TwitterMedia => item !== null);
}

function asQuotedTweet(value: unknown): QuotedTweetData | undefined {
	const quote = asRecord(value);
	if (!quote) return undefined;
	const authorName = asString(quote.authorName);
	const authorUserName = asString(quote.authorUserName);
	const text = asString(quote.text);
	if (!authorName || !authorUserName || !text) return undefined;
	return {
		authorName,
		authorUserName,
		text,
		authorProfilePicture: asString(quote.authorProfilePicture),
	};
}

function asRetweetedBy(value: unknown): RetweetedByData | undefined {
	const retweet = asRecord(value);
	if (!retweet) return undefined;
	const authorName = asString(retweet.authorName);
	const authorUserName = asString(retweet.authorUserName);
	if (!authorName || !authorUserName) return undefined;
	return {
		authorName,
		authorUserName,
		tweetId: asString(retweet.tweetId),
		tweetUrl: asString(retweet.tweetUrl),
		retweetedAt: asString(retweet.retweetedAt),
		authorProfilePicture: asString(retweet.authorProfilePicture),
		authorVerified: asBoolean(retweet.authorVerified),
	};
}

function parseTwitterAuthor(metadata: Record<string, unknown>): TwitterAuthorFields {
	return {
		authorName: asString(metadata.authorName) ?? '',
		authorUserName: asString(metadata.authorUserName) ?? '',
		authorProfilePicture: asString(metadata.authorProfilePicture),
		authorVerified: asBoolean(metadata.authorVerified),
	};
}

export function parsePlatformMetadata(metadata: Record<string, unknown> | undefined, fallbackType: string): PlatformMetadata | null {
	if (!metadata) return null;
	const type = asPlatformType(metadata.type, fallbackType);

	switch (type) {
		case 'youtube':
			return buildMetadata('youtube', {
				videoId: asString(metadata.videoId) ?? '',
				channelName: asString(metadata.channelName) ?? '',
				channelId: asString(metadata.channelId),
				channelAvatar: asString(metadata.channelAvatar),
				duration: asString(metadata.duration),
				thumbnailUrl: asString(metadata.thumbnailUrl),
				viewCount: asNumber(metadata.viewCount),
				likeCount: asNumber(metadata.likeCount),
				commentCount: asNumber(metadata.commentCount),
				publishedAt: asString(metadata.publishedAt),
				description: asString(metadata.description),
				tags: asStringArray(metadata.tags),
			});
		case 'hackernews':
			return buildMetadata('hackernews', {
				itemId: asString(metadata.itemId) ?? '',
				author: asString(metadata.author) ?? '',
				points: asNumber(metadata.points) ?? 0,
				commentCount: asNumber(metadata.commentCount) ?? 0,
				itemType: asEnum(metadata.itemType, HACKERNEWS_ITEM_TYPES),
				storyUrl: asNullableString(metadata.storyUrl),
			});
		case 'twitter': {
			const baseData = { ...parseTwitterAuthor(metadata), tweetId: asString(metadata.tweetId) };
			const variant = asEnum(metadata.variant, TWITTER_VARIANTS);
			if (variant === 'article') return buildMetadata('twitter', { ...baseData, variant: 'article' });

			const base: TwitterMetadata = {
				...baseData,
				media: asTwitterMediaArray(metadata.media),
				createdAt: asString(metadata.createdAt),
				retweetedBy: asRetweetedBy(metadata.retweetedBy),
			};
			if (variant === 'shared') {
				return buildMetadata('twitter', {
					...base,
					variant: 'shared',
					tweetText: asString(metadata.tweetText),
					externalUrl: asString(metadata.externalUrl) ?? '',
					externalOgImage: asNullableString(metadata.externalOgImage),
					externalTitle: asNullableString(metadata.externalTitle),
					originalTweetUrl: asString(metadata.originalTweetUrl),
				});
			}
			return buildMetadata('twitter', { ...base, quotedTweet: asQuotedTweet(metadata.quotedTweet) });
		}
		default:
			return buildMetadata('default', null);
	}
}
