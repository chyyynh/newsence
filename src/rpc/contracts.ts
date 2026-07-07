const QUOTA_EXCEEDED_CODE = 'QUOTA_EXCEEDED';
type QuotaExceededCode = typeof QUOTA_EXCEEDED_CODE;

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

export type ArticleRankSearchInput = {
	query: string;
	limit?: number;
};

export type RelatedArticleSearchInput = {
	seed: { id: string; type: 'article' | 'user_file' };
	limit?: number;
	offset?: number;
};

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

interface StoredGeneratedImage {
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

type StoreGeneratedImageResult =
	| { ok: true; result: StoredGeneratedImage }
	| {
			ok: false;
			code: 'BAD_REQUEST' | 'PAYLOAD_TOO_LARGE' | QuotaExceededCode | 'UNSUPPORTED_MEDIA_TYPE' | 'INTERNAL_ERROR';
			message: string;
	  };

type CoreUrlIngestResult = {
	url: string;
	userFileId?: string;
	instanceId?: string;
	title?: string;
	titleCn?: string;
	summaryCn?: string;
	tags?: string[];
	ogImageUrl?: string | null;
	resourceKind?: 'url' | 'blob';
	originType?: 'saved_url';
	platformType?: string;
	fileType?: string;
	alreadyExists?: boolean;
	error?: string;
};

type CoreUrlIngestOutcome =
	| { ok: true; results: CoreUrlIngestResult[] }
	| { ok: false; code: 'BATCH_TOO_LARGE' | 'RATE_LIMITED' | 'BAD_REQUEST' | 'UNAUTHORIZED'; message: string };

export type CoreUploadedFileInput = {
	userId: string;
	fileName: string;
	contentType: string;
	bytes: Uint8Array;
	title?: string | null;
};

type CoreMediaIngestResult = {
	userFileId: string;
	storageKey: string;
	assetUrl: string;
	fileType: string;
	fileSize: number;
	title: string | null;
	originType: 'upload';
	instanceId?: string;
};

type CoreMediaIngestOutcome =
	| { ok: true; result: CoreMediaIngestResult }
	| {
			ok: false;
			code: 'BAD_REQUEST' | 'RATE_LIMITED' | 'PAYLOAD_TOO_LARGE' | QuotaExceededCode | 'UNSUPPORTED_MEDIA_TYPE' | 'INTERNAL_ERROR';
			message: string;
	  };

export interface CoreRpc {
	storeGeneratedImage(input: StoreGeneratedImageInput): Promise<StoreGeneratedImageResult>;
	ingestUrls(input: { urls: string[]; userId?: string }): Promise<CoreUrlIngestOutcome>;
	ingestUploadedFile(input: CoreUploadedFileInput): Promise<CoreMediaIngestOutcome>;
	searchArticles(input: ArticleSearchInput): Promise<ArticleSummary[]>;
	searchArticleRanks(input: ArticleRankSearchInput): Promise<Array<{ id: string; score: number }>>;
	relatedArticleIds(input: RelatedArticleSearchInput): Promise<string[]>;
	scrapeUrl(url: string): Promise<ScrapedUrlContent>;
	readCorpusItems(items: ReadContextItem[], userId: string): Promise<ReadContextResult[]>;
}
