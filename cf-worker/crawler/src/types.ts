export interface Env {
	SUPABASE_URL: string;
	SUPABASE_SERVICE_ROLE_KEY: string;
	KAITO_API_KEY: string;
	API_SECRET_KEY: string;
}

export interface ScrapeRequest {
	url: string;
	userId: string;
	collectionId?: string;
	skipSave?: boolean;
}

export interface ScrapeResponse {
	success: true;
	data: {
		articleId?: string;
		url: string;
		normalizedUrl: string;
		title: string;
		content: string;
		summary?: string;
		source: string;
		sourceType: 'web' | 'twitter';
		ogImageUrl?: string;
		publishedDate?: string;
		author?: string;
		metadata?: Record<string, unknown>;
	};
	alreadyExists?: boolean;
	existingArticleId?: string;
}

export interface ScrapeErrorResponse {
	success: false;
	error: {
		code:
			| 'INVALID_URL'
			| 'FETCH_FAILED'
			| 'PARSE_FAILED'
			| 'UNAUTHORIZED'
			| 'RATE_LIMITED'
			| 'INTERNAL_ERROR';
		message: string;
		details?: unknown;
	};
}

export interface ScrapedContent {
	title: string;
	content: string;
	summary?: string;
	ogImageUrl: string | null;
	siteName: string | null;
	author: string | null;
	publishedDate: string | null;
	metadata?: Record<string, unknown>;
}

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
	media?: Array<{ url: string; type: string }>;
	hashTags?: string[];
	mentions?: unknown[];
	urls?: unknown[];
	lang?: string;
}
