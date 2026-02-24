import type { ExecutionContext, MessageBatch, Queue, ScheduledEvent } from '@cloudflare/workers-types';

// Environment variables
export interface Env {
	SUPABASE_URL: string;
	SUPABASE_SERVICE_ROLE_KEY: string;
	OPENROUTER_API_KEY: string;
	CORE_WORKER_INTERNAL_TOKEN?: string;
	SUBMIT_RATE_LIMIT_MAX?: string;
	SUBMIT_RATE_LIMIT_WINDOW_SEC?: string;
	KAITO_API_KEY?: string;
	YOUTUBE_API_KEY?: string;
	TRANSCRIPT_API_KEY?: string;
	ARTICLES_TABLE?: string;

	// Queue binding
	ARTICLE_QUEUE: Queue;

	// Workflow binding
	MONITOR_WORKFLOW: any; // Workflow type from cloudflare:workers

	// Workers AI binding
	AI: Ai;
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
	platform_metadata?: {
		type?: string;
		fetchedAt?: string;
		data?: Record<string, any>;
		enrichments?: Record<string, any>;
	};
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

// Twitter related
export interface Tweet {
	id?: string;
	url: string;
	createdAt: string;
	viewCount: number;
	author: {
		id?: string;
		userName: string;
		name: string;
		verified?: boolean;
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
	mentions?: any[];
	urls?: any[];
	lang?: string;
	possiblySensitive?: boolean;
	source?: string;
	listType?: string;
}

// Queue message types
export type QueueMessage =
	| { type: 'article_process'; article_id: string; source_type: string }
	| { type: 'batch_process'; article_ids: string[]; triggered_by: string };

// Exported handlers
export type { ScheduledEvent, ExecutionContext, Queue, MessageBatch };
