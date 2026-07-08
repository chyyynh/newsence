import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { generateArticleEmbedding, prepareArticleTextForEmbedding } from '@core-ai/embedding';
import type { Article, NormalizedContent, PaperMetadata, PlatformMetadata, YoutubeTranscript } from '@core-shared/types';
import { extractYouTubeId, FEED_UA, fetchWithTimeout, readBytesWithLimit, readTextWithLimit } from '@core-shared/web';
import { normalizeArticleEntityUpdatePayload } from '@entities/normalize';
import {
	insertFinalSourceArticle,
	loadArticleForProcessing,
	syncArticleEntities,
	updateArticleAfterProcessing,
} from '@ingest/domain/article-store';
import { Client } from 'pg';
import { generateArticleAnalysis, mergeArticleAnalysis, type ProcessorResult } from './domain/ai-utils';
import { extractHackerNewsId, processHackerNewsArticle, scrapeHackerNews } from './platforms/hackernews';
import { stagePaperEnrichment, syncPaperGraphForEnrichment } from './platforms/paper';
import { type PdfTextArtifact, parsePdfBytes, stagePdfTextExtraction } from './platforms/pdf';
import { extractTweetId, processTwitterArticle, scrapeTweet } from './platforms/twitter';
import { persistYouTubeWorkflowData, prepareYouTubeHighlights, scrapeYouTube } from './platforms/youtube';

const PDF_MIME = 'application/pdf';
const GENERIC_FETCH_TIMEOUT_MS = 8_000;
const GENERIC_HTML_MAX_BYTES = 5 * 1024 * 1024;
const GENERIC_PDF_MAX_BYTES = 25 * 1024 * 1024;

type PdfExtractionMetadata = {
	status: PdfTextArtifact['status'];
	parser: 'liteparse';
	chars: number;
	pages: number;
};

type AcquiredContent = NormalizedContent & { extraction?: PdfExtractionMetadata };

function sourceRecordToArticle(data: SourceArticleRecord): Article {
	return {
		id: data.url,
		title: data.title,
		title_cn: null,
		summary: data.summary || null,
		summary_cn: null,
		content: data.content,
		content_cn: null,
		url: data.url,
		source: data.source,
		published_date: typeof data.publishedDate === 'string' ? data.publishedDate : data.publishedDate.toISOString(),
		tags: data.tags ?? [],
		keywords: data.keywords ?? [],
		source_type: data.sourceType,
		platform_metadata: data.platformMetadata as Article['platform_metadata'],
	};
}

function buildProcessorUpdatePayload(
	article: Article,
	result: ProcessorResult,
	embedding?: number[] | null,
	metadataPatch?: Record<string, unknown>,
): Record<string, unknown> {
	const updatePayload: Record<string, unknown> = { ...result.updateData };
	const category = result.classificationCategory;
	const hasEnrichments = !!result.enrichments && Object.keys(result.enrichments).length > 0;
	let mergedMetadata: PlatformMetadata | null = article.platform_metadata ?? null;
	if (hasEnrichments && mergedMetadata) {
		mergedMetadata = {
			...mergedMetadata,
			enrichments: { ...(mergedMetadata.enrichments || {}), ...result.enrichments, processedAt: new Date().toISOString() },
		};
	}
	if (category) {
		const base = mergedMetadata ??
			article.platform_metadata ?? { type: 'default' as const, fetchedAt: new Date().toISOString(), data: null };
		mergedMetadata = {
			...base,
			classification: {
				...(base.classification ?? {}),
				category,
				classifiedAt: new Date().toISOString(),
			},
		};
	}
	if (metadataPatch) updatePayload.platform_metadata = { ...(mergedMetadata ?? article.platform_metadata ?? {}), ...metadataPatch };
	else if (mergedMetadata) updatePayload.platform_metadata = mergedMetadata;
	if (embedding?.length) updatePayload.embedding = `[${embedding.join(',')}]`;
	return updatePayload;
}

type StoredWorkflowTarget = { kind: 'article' | 'userFile'; rowId: string };

type WorkflowTarget = StoredWorkflowTarget | { kind: 'source'; draft: SourceArticleDraft };
type SourceArticleRecord = Parameters<typeof insertFinalSourceArticle>[1];

interface SourceArticleDraft {
	article: SourceArticleRecord;
	youtubeTranscript?: YoutubeTranscript;
}

const ACTIVE_WORKFLOW_STATUSES = new Set(['queued', 'running', 'paused', 'waiting', 'waitingForPause']);

export async function enqueueProcessing(env: CoreEnv, target: WorkflowTarget): Promise<string> {
	const workflowId = target.kind === 'source' ? await sourceArticleWorkflowId(target.draft.article.url) : storedWorkflowId(target);
	const [created] = await env.MONITOR_WORKFLOW.createBatch([{ id: workflowId, params: { target } }]);
	if (created) return created.id;

	const instance = await env.MONITOR_WORKFLOW.get(workflowId);
	const { status } = await instance.status();
	if (ACTIVE_WORKFLOW_STATUSES.has(status) || (target.kind === 'source' && status === 'complete')) return instance.id;

	await instance.restart();
	return instance.id;
}

function workflowIdPart(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
}

function storedTargetTable(target: StoredWorkflowTarget): 'articles' | 'user_files' {
	return target.kind === 'article' ? 'articles' : 'user_files';
}

function storedWorkflowId(target: StoredWorkflowTarget): string {
	return ['article', workflowIdPart(storedTargetTable(target)), workflowIdPart(target.rowId)].join('-');
}

async function sourceArticleWorkflowId(url: string): Promise<string> {
	const bytes = new TextEncoder().encode(url);
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	const hash = [...new Uint8Array(digest)]
		.slice(0, 16)
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
	return `source-article-${hash}`;
}

function urlHost(url: string): string {
	return new URL(url).hostname.replace(/^www\./, '');
}

function fileNameFromUrl(url: string, fallback: string): string {
	const name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? '');
	return name || fallback;
}

function pdfExtractionMetadata(pdf: PdfTextArtifact): PdfExtractionMetadata {
	return { status: pdf.status, parser: 'liteparse', chars: pdf.chars, pages: pdf.pages };
}

type HtmlMetadata = NormalizedContent['metadata'] & { title: string | null };

function metaContentHandler(assign: (value: string) => void): HTMLRewriterElementContentHandlers {
	return {
		element(element) {
			const content = element.getAttribute('content')?.trim();
			if (content) assign(content);
		},
	};
}

async function extractHtmlMetadata(html: string, url: string): Promise<HtmlMetadata> {
	let titleText = '';
	let title: string | null = null;
	let description: string | null = null;
	let siteName: string | null = null;
	let author: string | null = null;
	let publishedDate: string | null = null;
	const setOnce = (set: (value: string) => void, current: () => string | null) => (value: string) => {
		if (!current()) set(value);
	};

	let rewriter = new HTMLRewriter().on('title', {
		text(text) {
			titleText += text.text;
		},
	});
	for (const [selector, assign, current] of [
		['meta[property="og:title"]', (value: string) => (title = value), () => title],
		['meta[name="twitter:title"]', (value: string) => (title = value), () => title],
		['meta[property="og:description"]', (value: string) => (description = value), () => description],
		['meta[name="description"]', (value: string) => (description = value), () => description],
		['meta[property="og:site_name"]', (value: string) => (siteName = value), () => siteName],
		['meta[name="author"]', (value: string) => (author = value), () => author],
		['meta[property="article:author"]', (value: string) => (author = value), () => author],
		['meta[property="article:published_time"]', (value: string) => (publishedDate = value), () => publishedDate],
	] as const) {
		rewriter = rewriter.on(selector, metaContentHandler(setOnce(assign, current)));
	}

	await rewriter
		.on('time[datetime]', {
			element(element) {
				if (!publishedDate) publishedDate = element.getAttribute('datetime')?.trim() || null;
			},
		})
		.transform(new Response(html))
		.arrayBuffer();

	return {
		title: title ?? (titleText.trim() || null),
		author,
		publishedDate,
		siteName: siteName ?? urlHost(url),
		description,
	};
}

function titleFromMarkdown(markdown: string): string | null {
	return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || null;
}

async function markdownFromHtml(env: CoreEnv, html: string, url: string): Promise<string> {
	const result = await env.AI.toMarkdown({
		name: fileNameFromUrl(url, `${urlHost(url)}.html`),
		blob: new Blob([html], { type: 'text/html' }),
	});
	if (result.format === 'error') throw new Error(`Workers AI toMarkdown failed: ${result.error}`);
	return result.data.trim();
}

async function scrapePdfUrl(url: string, response: Response): Promise<AcquiredContent> {
	const bytes = await readBytesWithLimit(response, GENERIC_PDF_MAX_BYTES);
	const parsed = await parsePdfBytes(bytes);
	const fileName = fileNameFromUrl(response.url || url, 'document.pdf');
	const title = fileName.replace(/\.pdf$/i, '') || 'PDF document';
	return {
		title,
		markdown: parsed.text,
		metadata: {
			author: null,
			publishedDate: null,
			siteName: urlHost(response.url || url),
			description: parsed.text.slice(0, 500) || null,
		},
		platformMetadata: {
			type: 'pdf',
			fetchedAt: new Date().toISOString(),
			data: { fileName, fileSize: bytes.byteLength },
		},
		extraction: pdfExtractionMetadata(parsed),
	};
}

async function scrapeGenericUrl(url: string, env: CoreEnv): Promise<AcquiredContent> {
	const response = await fetchWithTimeout(
		url,
		{
			headers: {
				'User-Agent': FEED_UA,
				Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.5',
				'Accept-Language': 'en-US,en;q=0.9,zh-TW;q=0.8,zh;q=0.7',
			},
		},
		GENERIC_FETCH_TIMEOUT_MS,
	);
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`HTTP ${response.status}: ${response.statusText}`);
	}

	const contentType = response.headers.get('content-type')?.toLowerCase() || '';
	if (contentType.includes(PDF_MIME) || new URL(response.url || url).pathname.toLowerCase().endsWith('.pdf')) {
		return scrapePdfUrl(url, response);
	}
	if (
		contentType &&
		!contentType.includes('text/html') &&
		!contentType.includes('text/xml') &&
		!contentType.includes('application/xhtml') &&
		!contentType.includes('application/xml')
	) {
		await response.body?.cancel();
		throw new Error(`Unsupported response content type: ${contentType}`);
	}

	const finalUrl = response.url || url;
	const html = await readTextWithLimit(response, GENERIC_HTML_MAX_BYTES);
	const [metadata, markdown] = await Promise.all([extractHtmlMetadata(html, finalUrl), markdownFromHtml(env, html, finalUrl)]);
	const title = metadata.title ?? titleFromMarkdown(markdown) ?? urlHost(finalUrl);
	return {
		title,
		markdown,
		metadata: {
			author: metadata.author,
			publishedDate: metadata.publishedDate,
			siteName: metadata.siteName,
			description: metadata.description,
		},
		platformMetadata: { type: 'default', fetchedAt: new Date().toISOString(), data: null },
	};
}

async function scrapeSavedUrl(url: string, env: CoreEnv): Promise<AcquiredContent | null> {
	const parsed = new URL(url);
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only http(s) URLs are allowed');
	if (parsed.username || parsed.password) throw new Error('URL must not include credentials');

	const videoId = extractYouTubeId(url);
	if (videoId) return scrapeYouTube(videoId, env.YOUTUBE_API_KEY);

	const tweetId = extractTweetId(url);
	if (tweetId) return scrapeTweet(tweetId, env.KAITO_API_KEY);

	const hackerNewsId = extractHackerNewsId(url);
	if (hackerNewsId) return scrapeHackerNews(hackerNewsId);

	return scrapeGenericUrl(url, env);
}

function applyAcquiredContent(article: Article, acquired: AcquiredContent | null): Article {
	if (!acquired) return article;
	const acquiredTitle = acquired.title?.trim();
	return {
		...article,
		title: acquiredTitle || article.title,
		summary: acquired.metadata.description ?? article.summary,
		content: acquired.markdown || article.content,
		source: acquired.metadata.siteName ?? acquired.metadata.author ?? article.source,
		published_date: acquired.metadata.publishedDate ?? article.published_date,
		source_type: acquired.platformMetadata?.type ?? article.source_type,
		platform_metadata: acquired.platformMetadata ?? article.platform_metadata,
		file_type: acquired.platformMetadata?.type === 'pdf' ? PDF_MIME : article.file_type,
	};
}

function acquiredContentUpdatePayload(acquired: AcquiredContent | null): Record<string, unknown> {
	if (!acquired) return {};
	const acquiredTitle = acquired.title?.trim();
	return {
		...(acquiredTitle ? { title: acquiredTitle } : {}),
		...(acquired.metadata.siteName || acquired.metadata.author ? { source: acquired.metadata.siteName ?? acquired.metadata.author } : {}),
		...(acquired.metadata.publishedDate ? { published_date: acquired.metadata.publishedDate } : {}),
		...(acquired.metadata.description !== null ? { summary: acquired.metadata.description } : {}),
		content: acquired.markdown,
		...(acquired.platformMetadata
			? {
					source_type: acquired.platformMetadata.type,
					platform_metadata: acquired.platformMetadata,
				}
			: {}),
	};
}

async function acquireSavedUrlContent(env: CoreEnv, article: Article): Promise<ReadableStream<Uint8Array>> {
	const acquired = await scrapeSavedUrl(article.url, env);
	return new Response(JSON.stringify(acquired)).body!;
}

async function stageSavedUrlAcquisition(env: CoreEnv, step: WorkflowStep, article: Article): Promise<AcquiredContent | null> {
	const artifact = await step.do(
		'acquire-content',
		{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
		() => acquireSavedUrlContent(env, article),
	);
	return (await new Response(artifact).json()) as AcquiredContent | null;
}

async function loadFullTargetArticle(
	env: CoreEnv,
	target: WorkflowTarget,
	pdfTextArtifact: PdfTextArtifact | null,
	acquiredContent: AcquiredContent | null = null,
	baseArticle?: Article,
): Promise<Article> {
	let article: Article;
	if (baseArticle) {
		article = baseArticle;
	} else if (target.kind === 'source') {
		article = sourceRecordToArticle(target.draft.article);
	} else {
		article = await loadArticleForProcessing(env, storedTargetTable(target), target.rowId);
	}
	article = applyAcquiredContent(article, acquiredContent);
	const extractedPdfText = pdfTextArtifact?.text?.trim() || null;
	return extractedPdfText === null ? article : { ...article, content: extractedPdfText };
}

async function persistWorkflowTarget(
	env: CoreEnv,
	target: WorkflowTarget,
	article: Article,
	result: ProcessorResult,
	embedding: number[] | null,
	pdfTextArtifact: PdfTextArtifact | null,
	acquiredContent: AcquiredContent | null,
	paperEnrichment: PaperMetadata | null,
	youtubeTranscript: YoutubeTranscript | undefined,
	youtubeHighlights: Awaited<ReturnType<typeof prepareYouTubeHighlights>>,
): Promise<string> {
	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	await db.query('BEGIN');
	try {
		let articleId: string;
		if (target.kind === 'source') {
			const updatePayload = buildProcessorUpdatePayload(
				article,
				result,
				embedding,
				paperEnrichment ? { type: 'paper', data: paperEnrichment } : undefined,
			);
			const platformMetadata = updatePayload.platform_metadata ?? article.platform_metadata;
			const entities = normalizeArticleEntityUpdatePayload(updatePayload, article.source, platformMetadata);
			articleId = await insertFinalSourceArticle(db, target.draft.article, updatePayload);
			if (entities) await syncArticleEntities(db, articleId, entities, article.source, platformMetadata);
		} else {
			const finalResult =
				pdfTextArtifact?.text && article.content ? { ...result, updateData: { ...result.updateData, content: article.content } } : result;
			const extraction = pdfTextArtifact ? pdfExtractionMetadata(pdfTextArtifact) : acquiredContent?.extraction;
			const metadataPatch = {
				...(extraction ? { extraction } : {}),
				...(paperEnrichment ? { type: 'paper', data: paperEnrichment } : {}),
			};
			const updatePayload = {
				...acquiredContentUpdatePayload(acquiredContent),
				...buildProcessorUpdatePayload(article, finalResult, embedding, Object.keys(metadataPatch).length ? metadataPatch : undefined),
			};
			const platformMetadata = updatePayload.platform_metadata ?? article.platform_metadata;
			const entities = normalizeArticleEntityUpdatePayload(updatePayload, article.source, platformMetadata);

			const table = storedTargetTable(target);
			await updateArticleAfterProcessing(db, table, target.rowId, updatePayload);
			if (table === 'articles' && entities) await syncArticleEntities(db, target.rowId, entities, article.source, platformMetadata);
			articleId = target.rowId;
		}
		if (youtubeTranscript || youtubeHighlights)
			await persistYouTubeWorkflowData(db, { transcript: youtubeTranscript, highlights: youtubeHighlights });
		await db.query('COMMIT');
		return articleId;
	} catch (error) {
		await db
			.query('ROLLBACK')
			.catch((rollbackError) => console.error({ tag: 'DB', msg: 'workflow target rollback failed', error: String(rollbackError) }));
		throw error;
	}
}

export class NewsenceMonitorWorkflow extends WorkflowEntrypoint<CoreEnv, { target: WorkflowTarget }> {
	async run(event: WorkflowEvent<{ target: WorkflowTarget }>, step: WorkflowStep) {
		const target = event.payload.target;
		const initialArticle = await step.do(
			target.kind === 'source' ? 'load-source-article-shell' : 'fetch-article-shell',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => {
				if (target.kind === 'source') return { ...sourceRecordToArticle(target.draft.article), content: null };
				return loadArticleForProcessing(this.env, storedTargetTable(target), target.rowId, true);
			},
		);
		const initialHasContent = 'has_content' in initialArticle && !!initialArticle.has_content;
		const acquiredContent =
			target.kind === 'userFile' && !initialHasContent && !initialArticle.storage_key && initialArticle.url
				? await stageSavedUrlAcquisition(this.env, step, initialArticle)
				: null;
		const article = applyAcquiredContent(initialArticle, acquiredContent);
		const metadataType = article.platform_metadata?.type;
		const sourceType =
			metadataType && metadataType !== 'pdf' && metadataType !== 'paper' ? metadataType : (article.source_type ?? 'default');
		const logContext =
			target.kind === 'source' ? { url: article.url, table: 'articles' } : { article_id: target.rowId, table: storedTargetTable(target) };

		console.info({ tag: 'WORKFLOW', msg: 'Starting', sourceType, ...logContext });

		const hasContent = 'has_content' in article && !!article.has_content;
		const pdfTextArtifact =
			target.kind === 'userFile' && !hasContent && article.storage_key && article.file_type === PDF_MIME
				? await stagePdfTextExtraction(this.env, step, {
						sourceStorageKey: article.storage_key,
					})
				: null;

		const paperEnrichment = await stagePaperEnrichment(this.env, step, article, {
			hasStagedText: !!pdfTextArtifact?.text,
			loadContent: async () =>
				(await loadFullTargetArticle(this.env, target, pdfTextArtifact, acquiredContent, acquiredContent ? article : undefined)).content,
		});

		const processorResult = await step.do(
			'ai-analysis',
			{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '180 seconds' },
			async () => {
				const fullArticle = await loadFullTargetArticle(
					this.env,
					target,
					pdfTextArtifact,
					acquiredContent,
					acquiredContent ? article : undefined,
				);
				if (sourceType === 'hackernews') return processHackerNewsArticle(fullArticle, this.env);
				if (sourceType === 'twitter') return processTwitterArticle(fullArticle, this.env);
				return mergeArticleAnalysis(fullArticle, await generateArticleAnalysis(fullArticle, this.env));
			},
		);

		const embedding = await step.do(
			'generate-embedding',
			{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
			async () => {
				const fullArticle = await loadFullTargetArticle(
					this.env,
					target,
					pdfTextArtifact,
					acquiredContent,
					acquiredContent ? article : undefined,
				);
				const text = prepareArticleTextForEmbedding({
					title: fullArticle.title,
					summary: processorResult.updateData.summary ?? fullArticle.summary,
					content: processorResult.updateData.content ?? fullArticle.content,
					tags: processorResult.updateData.tags ?? fullArticle.tags,
					keywords: processorResult.updateData.keywords ?? fullArticle.keywords,
				});
				return text && this.env.AI ? generateArticleEmbedding(text, this.env.AI, this.env.AI_GATEWAY_NAME) : null;
			},
		);

		const youtubeTranscript =
			sourceType === 'youtube'
				? target.kind === 'source'
					? target.draft.youtubeTranscript
					: acquiredContent?.youtubeTranscript
				: undefined;
		const youtubeHighlights =
			sourceType === 'youtube'
				? await step.do(
						'prepare-youtube-highlights',
						{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
						async () => prepareYouTubeHighlights(this.env, article, youtubeTranscript),
					)
				: null;
		const articleId = await step.do(
			target.kind === 'source' ? 'insert-final-article' : 'update-db',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () =>
				persistWorkflowTarget(
					this.env,
					target,
					target.kind === 'source' || pdfTextArtifact?.text || acquiredContent
						? await loadFullTargetArticle(this.env, target, pdfTextArtifact, acquiredContent, acquiredContent ? article : undefined)
						: article,
					processorResult,
					embedding,
					pdfTextArtifact,
					acquiredContent,
					paperEnrichment,
					youtubeTranscript,
					youtubeHighlights,
				),
		);

		await syncPaperGraphForEnrichment(this.env, step, articleId, paperEnrichment);

		console.info({ tag: 'WORKFLOW', msg: 'Completed', article_id: articleId, ...logContext });
		return { success: true, article_id: articleId };
	}
}
