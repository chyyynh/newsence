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

export type ExportCollectionOkfInput = {
	collectionId: string;
	userId?: string | null;
};

type CoreUrlBlobCandidate = {
	body: ReadableStream<Uint8Array>;
	contentType: string;
	sourceUrl: string;
	suggestedFilename: string;
	contentLength: number | null;
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
	blob?: CoreUrlBlobCandidate;
	alreadyExists?: boolean;
	error?: string;
};

type CoreUrlIngestOutcome =
	| { ok: true; results: CoreUrlIngestResult[] }
	| { ok: false; code: 'BATCH_TOO_LARGE' | 'RATE_LIMITED' | 'BAD_REQUEST' | 'UNAUTHORIZED'; message: string };

export interface CoreRpc {
	ingestUrls(input: { urls: string[]; userId?: string }): Promise<CoreUrlIngestOutcome>;
	enqueueUserFileProcessing(userFileId: string): Promise<string>;
	searchArticles(input: ArticleSearchInput): Promise<ArticleSummary[]>;
	searchArticleRanks(input: ArticleRankSearchInput): Promise<Array<{ id: string; score: number }>>;
	relatedArticleIds(input: RelatedArticleSearchInput): Promise<string[]>;
	exportCollectionOkf(input: ExportCollectionOkfInput): Promise<Response>;
	readCorpusItems(items: ReadContextItem[], userId: string): Promise<ReadContextResult[]>;
}
