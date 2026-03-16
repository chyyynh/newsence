import type { ExecutionContext, MessageBatch, Queue, ScheduledEvent } from '@cloudflare/workers-types';
import type { PlatformMetadata } from './platform-metadata';

/**
 * Environment bindings.
 * Extends wrangler-generated Cloudflare.Env (from worker-configuration.d.ts)
 * with secrets that are not in wrangler.jsonc.
 */
export interface Env extends Cloudflare.Env {
	OPENROUTER_API_KEY: string;
	CORE_WORKER_INTERNAL_TOKEN?: string;
	SUBMIT_RATE_LIMIT_MAX?: string;
	SUBMIT_RATE_LIMIT_WINDOW_SEC?: string;
	KAITO_API_KEY?: string;
	YOUTUBE_API_KEY?: string;
	CLIP_API_SECRET?: string;
	CF_ACCOUNT_ID: string;
	CF_API_TOKEN: string;
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
	platform_metadata?: PlatformMetadata;
}

// AI Analysis result
export interface AIAnalysisResult {
	tags: string[];
	keywords: string[];
	summary_en: string;
	summary_cn: string;
	title_en?: string;
	title_cn?: string;
	category: string;
}

// OpenRouter API response
export interface OpenRouterResponse {
	choices: Array<{
		message: {
			content: string | null;
		};
	}>;
}

// RSS Feed related
export interface RSSFeed {
	id: string;
	name: string;
	RSSLink: string;
	url: string;
	type: string;
	scraped_at?: string;
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
	};
	text: string;
	likeCount?: number;
	retweetCount?: number;
	replyCount?: number;
	quoteCount?: number;
	extendedEntities?: {
		media?: Array<{ media_url_https: string; type: string }>;
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
}

// Queue message types
export type QueueMessage =
	| { type: 'article_process'; article_id: string; source_type: string }
	| { type: 'batch_process'; article_ids: string[]; triggered_by: string };

// Exported handlers
export type { ScheduledEvent, ExecutionContext, Queue, MessageBatch };
