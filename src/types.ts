import { ScheduledEvent, ExecutionContext, Queue, MessageBatch } from '@cloudflare/workers-types';

// Environment variables
export interface Env {
	SUPABASE_URL: string;
	SUPABASE_SERVICE_ROLE_KEY: string;
	OPENROUTER_API_KEY: string;
	KAITO_API_KEY?: string;
	TELEGRAM_BOT_TOKEN?: string;
	TELEGRAM_CHAT_ID?: string;
	ARTICLES_TABLE?: string;

	// Queue bindings
	RSS_QUEUE: Queue;
	TWITTER_QUEUE: Queue;
	ARTICLE_QUEUE: Queue;

	// Workflow binding
	MONITOR_WORKFLOW: any; // Workflow type from cloudflare:workers
}

// Article related types
export interface Article {
	id: string;
	title: string;
	title_cn?: string | null;
	summary: string | null;
	summary_cn?: string | null;
	content: string | null;
	url: string;
	source: string;
	published_date: string;
	scraped_date?: string;
	tags: string[];
	keywords: string[];
	source_type?: string;
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
	media?: any[];
	hashTags?: string[];
	mentions?: any[];
	urls?: any[];
	lang?: string;
	possiblySensitive?: boolean;
	source?: string;
	listType?: string;
}

// Queue message types
export interface QueueMessage {
	type: string;
	article_id?: string;
	url?: string;
	source?: string;
	source_type?: string;
	timestamp?: string;
	article_ids?: string[];
	triggered_by?: string;
	batch_info?: {
		batch_size: number;
		total_batches: number;
	};
	metadata?: any;
}

// Exported handlers
export type { ScheduledEvent, ExecutionContext, Queue, MessageBatch };
