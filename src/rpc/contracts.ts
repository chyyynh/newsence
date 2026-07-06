export const QUOTA_EXCEEDED_CODE = 'QUOTA_EXCEEDED';
export type QuotaExceededCode = typeof QUOTA_EXCEEDED_CODE;

export interface ArticleSummary {
	id: string;
	title: string;
	url: string;
	publishedDate?: string;
	source?: string | null;
	summary?: string;
	tags?: string[] | null;
}

export type ArticleSearchInput = {
	query: string;
	daysAgo?: number;
	limit?: number;
};

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface ReadContextItem {
	type: 'article' | 'collection' | 'url';
	id: string;
}

export interface ReadContextResult {
	type: 'article' | 'collection' | 'url' | 'document' | 'error';
	id: string;
	title?: string;
	content?: string;
	articles?: Array<{ id: string; title: string; summary: string | null }>;
	metadata?: Record<string, unknown>;
	error?: string;
}

export interface ScrapedUrlContent {
	sourceUrl: string | null;
	contentType: string;
	title: string | null;
	markdown: string;
	text: string;
	metadata: {
		author: string | null;
		publishedDate: string | null;
		siteName: string | null;
		description: string | null;
		ogImageUrl: string | null;
		pages?: number;
		chars?: number;
	};
	status: 'ok' | 'needs_ocr' | 'failed';
}

export interface StoredGeneratedImage {
	userFileId: string;
	storageKey: string;
	assetUrl: string;
	fileType: string;
	fileSize: number;
}

export type StoreGeneratedImageInput = {
	userId: string;
	bytes: Uint8Array;
	contentType: string;
	title: string;
};

export type StoreGeneratedImageResult =
	| { ok: true; result: StoredGeneratedImage }
	| {
			ok: false;
			code: 'BAD_REQUEST' | 'PAYLOAD_TOO_LARGE' | QuotaExceededCode | 'UNSUPPORTED_MEDIA_TYPE' | 'INTERNAL_ERROR';
			message: string;
	  };

export interface CoreRpc {
	storeGeneratedImage(input: StoreGeneratedImageInput): Promise<StoreGeneratedImageResult>;
	searchArticles(input: ArticleSearchInput): Promise<ArticleSummary[]>;
	scrapeUrl(url: string): Promise<ScrapedUrlContent>;
	readCorpusItems(items: ReadContextItem[], userId: string): Promise<ReadContextResult[]>;
}
