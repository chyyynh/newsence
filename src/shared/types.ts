import type { ArticleCategory, PlatformMetadata, RetweetedByData } from './platform-metadata';

/**
 * Core-worker-owned environment bindings.
 *
 * Keep this owner-local instead of extending the ambient Cloudflare.Env. Wrangler
 * multi-config service binding typegen imports the callee source into the
 * caller's TypeScript program; an ambient Cloudflare.Env reference would then
 * resolve to the caller worker's Env instead of the core worker's Env.
 */
export interface Env {
	R2: R2Bucket;
	HYPERDRIVE: Hyperdrive;
	ARTICLE_QUEUE: Queue;
	USER_INGEST_LIMITER: RateLimit;
	BROWSER: Fetcher;
	AI: Ai;
	IMAGES: ImagesBinding;
	MONITOR_WORKFLOW: Workflow<unknown>;
	SCRAPE_WORKFLOW: Workflow<unknown>;
	AI_GATEWAY_NAME: string;
	POSTHOG_HOST?: string;
	BETTER_AUTH_SECRET?: string;
	CORE_WORKER_INTERNAL_TOKEN?: string;
	KAITO_API_KEY?: string;
	YOUTUBE_API_KEY?: string;
	/** Exa client key. Optional; the `search-web` tool refuses to run without it. */
	EXA_API_KEY?: string;
	/** PostHog project key (server). Set via `wrangler secret put POSTHOG_API_KEY`. */
	POSTHOG_API_KEY?: string;
	/** Semantic Scholar API key (optional). Set via `wrangler secret put S2_API_KEY`.
	 *  Without it, paper enrichment uses the unauthenticated (shared) S2 pool. */
	S2_API_KEY?: string;
}

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
	scraped_date?: string;
	tags: string[];
	keywords: string[];
	source_type?: string;
	og_image_url?: string | null;
	platform_metadata?: PlatformMetadata;
	// user_files-only raw columns (undefined for articles path).
	storage_key?: string | null;
	file_type?: string;
	origin_type?: string;
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

// RSS Feed related
export interface RSSFeed {
	id: string;
	name: string;
	RSSLink: string;
	url: string;
	type: string;
	scraped_at?: string;
	avatar_url?: string;
}

// Twitter related (Kaito API response shape)
export interface Tweet {
	id?: string;
	url: string;
	createdAt: string;
	viewCount: number;
	author: {
		id?: string;
		userName: string;
		name: string;
		profilePicture?: string;
		isBlueVerified?: boolean;
	};
	text: string;
	likeCount?: number;
	retweetCount?: number;
	replyCount?: number;
	quoteCount?: number;
	extendedEntities?: {
		media?: Array<{
			media_url_https: string;
			type: string;
			sizes?: { large?: { w: number; h: number } };
			video_info?: { variants?: Array<{ bitrate?: number; content_type?: string; url: string }> };
		}>;
	};
	hashTags?: string[];
	urls?: Array<{ expanded_url?: string; url?: string }>;
	lang?: string;
	// Thread & reply fields
	conversationId?: string;
	isReply?: boolean;
	inReplyToId?: string | null;
	inReplyToUsername?: string | null;
	// Quote & retweet
	quoted_tweet?: Tweet | null;
	retweeted_tweet?: Tweet | null;
	retweetedBy?: RetweetedByData;
}
