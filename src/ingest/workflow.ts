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
import { extractReadableArticleHtml, preferReadableArticleText } from './html-content';
import { extractHackerNewsId, processHackerNewsArticle, scrapeHackerNews } from './platforms/hackernews';
import { stagePaperEnrichment, syncPaperGraphForEnrichment } from './platforms/paper';
import { type PdfTextArtifact, parsePdfBytes, stagePdfTextExtraction } from './platforms/pdf';
import { extractTweetId, processTwitterArticle, scrapeTweet } from './platforms/twitter';
import { persistYouTubeWorkflowData, prepareYouTubeHighlights, scrapeYouTube } from './platforms/youtube';

const PDF_MIME = 'application/pdf';
const GENERIC_FETCH_TIMEOUT_MS = 8_000;
const GENERIC_HTML_MAX_BYTES = 5 * 1024 * 1024;
const GENERIC_PDF_MAX_BYTES = 25 * 1024 * 1024;
const OG_FETCH_TIMEOUT_MS = 6_000;
const OG_MAX_BYTES = 131_072;

type PdfExtractionMetadata = {
	status: PdfTextArtifact['status'];
	parser: 'liteparse';
	chars: number;
	pages: number;
};

type AcquiredContent = NormalizedContent & { extraction?: PdfExtractionMetadata; ogImage?: OgImagePatch };
type OgImagePatch = {
	ogImageUrl: string | null;
	ogImageWidth: number | null;
	ogImageHeight: number | null;
};

const EMPTY_OG_IMAGE_PATCH: OgImagePatch = {
	ogImageUrl: null,
	ogImageWidth: null,
	ogImageHeight: null,
};

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

type StoredWorkflowTarget = { kind: 'article' | 'userFile'; rowId: string; reacquire?: boolean };

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
	return [target.reacquire ? 'article-reacquire' : 'article', workflowIdPart(storedTargetTable(target)), workflowIdPart(target.rowId)].join(
		'-',
	);
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

function decodeHtmlEntities(value: string): string {
	return value
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
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

	const clean = (value: string | null): string | null => {
		const decoded = value ? decodeHtmlEntities(value).trim() : '';
		return decoded || null;
	};

	return {
		title: clean(title) ?? clean(titleText),
		author: clean(author),
		publishedDate: clean(publishedDate),
		siteName: clean(siteName) ?? urlHost(url),
		description: clean(description),
	};
}

function parsePositiveInt(raw: string | null): number | null {
	if (!raw) return null;
	const parsed = Number.parseInt(raw, 10);
	return parsed > 0 ? parsed : null;
}

function mergeChunks(chunks: Uint8Array[], total: number): Uint8Array {
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return merged;
}

function extractMeta(html: string, property: string): string | null {
	const re = new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i');
	const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, 'i');
	const raw = re.exec(html)?.[1] ?? re2.exec(html)?.[1] ?? null;
	return raw ? decodeHtmlEntities(raw).trim() || null : null;
}

function extractMetaName(html: string, name: string): string | null {
	const re = new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i');
	const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`, 'i');
	const raw = re.exec(html)?.[1] ?? re2.exec(html)?.[1] ?? null;
	return raw ? decodeHtmlEntities(raw).trim() || null : null;
}

function extractOgImageFromHtml(html: string, url: string): OgImagePatch {
	let ogImageUrl = extractMeta(html, 'og:image') || extractMeta(html, 'og:image:url') || extractMetaName(html, 'twitter:image');
	if (!ogImageUrl) return EMPTY_OG_IMAGE_PATCH;

	try {
		ogImageUrl = new URL(ogImageUrl, url).toString();
	} catch {
		return EMPTY_OG_IMAGE_PATCH;
	}
	if (ogImageUrl.startsWith('http://')) ogImageUrl = ogImageUrl.replace(/^http:/, 'https:');

	return {
		ogImageUrl,
		ogImageWidth: parsePositiveInt(extractMeta(html, 'og:image:width')),
		ogImageHeight: parsePositiveInt(extractMeta(html, 'og:image:height')),
	};
}

async function fetchOgImage(url: string): Promise<OgImagePatch> {
	try {
		const response = await fetchWithTimeout(
			url,
			{
				headers: {
					'User-Agent': FEED_UA,
					Accept: 'text/html,application/xhtml+xml',
				},
			},
			OG_FETCH_TIMEOUT_MS,
		);
		if (!response.ok || !response.body) {
			await response.body?.cancel();
			return EMPTY_OG_IMAGE_PATCH;
		}

		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let totalBytes = 0;
		while (totalBytes < OG_MAX_BYTES) {
			const { done, value } = await reader.read();
			if (done || !value) break;
			chunks.push(value);
			totalBytes += value.byteLength;
		}
		await reader.cancel();

		const html = new TextDecoder().decode(chunks.length === 1 ? chunks[0] : mergeChunks(chunks, totalBytes));
		return extractOgImageFromHtml(html, url);
	} catch {
		return EMPTY_OG_IMAGE_PATCH;
	}
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
	const [metadata, readable] = await Promise.all([extractHtmlMetadata(html, finalUrl), extractReadableArticleHtml(html)]);
	const markdown = await markdownFromHtml(env, readable?.html ?? html, finalUrl);
	const content = preferReadableArticleText(markdown, readable);
	const title = metadata.title ?? titleFromMarkdown(markdown) ?? urlHost(finalUrl);
	return {
		title,
		markdown: content,
		metadata: {
			author: metadata.author,
			publishedDate: metadata.publishedDate,
			siteName: metadata.siteName,
			description: metadata.description,
		},
		platformMetadata: { type: 'default', fetchedAt: new Date().toISOString(), data: null },
		ogImage: extractOgImageFromHtml(html, finalUrl),
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
	const acquiredSourceType = acquired.platformMetadata?.type;
	return {
		...article,
		title: acquiredTitle || article.title,
		summary: acquired.metadata.description ?? article.summary,
		content: acquired.markdown || article.content,
		source: acquired.metadata.siteName ?? acquired.metadata.author ?? article.source,
		published_date: acquired.metadata.publishedDate ?? article.published_date,
		source_type:
			article.source_type === 'rss' && acquiredSourceType === 'default' ? article.source_type : (acquiredSourceType ?? article.source_type),
		platform_metadata: acquired.platformMetadata ?? article.platform_metadata,
		file_type: acquired.platformMetadata?.type === 'pdf' ? PDF_MIME : article.file_type,
	};
}

function acquiredContentUpdatePayload(
	acquired: AcquiredContent | null,
	options?: { preserveSourceType?: boolean },
): Record<string, unknown> {
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
					...(options?.preserveSourceType ? {} : { source_type: acquired.platformMetadata.type }),
					platform_metadata: acquired.platformMetadata,
				}
			: {}),
	};
}

function withoutPlatformMetadata(payload: Record<string, unknown>): Record<string, unknown> {
	const { platform_metadata: _platformMetadata, ...rest } = payload;
	return rest;
}

function ogImageUpdatePayload(patch: OgImagePatch): Record<string, unknown> {
	const metadataPatch =
		patch.ogImageWidth && patch.ogImageHeight ? { ogImageWidth: patch.ogImageWidth, ogImageHeight: patch.ogImageHeight } : null;
	return {
		...(patch.ogImageUrl ? { og_image_url: patch.ogImageUrl } : {}),
		...(metadataPatch ? { platform_metadata: metadataPatch } : {}),
	};
}

function mergeMetadataPatch(...patches: Array<unknown>): Record<string, unknown> | undefined {
	const records = patches.filter(
		(patch): patch is Record<string, unknown> => !!patch && typeof patch === 'object' && !Array.isArray(patch),
	);
	if (!records.length) return undefined;
	return Object.assign({}, ...records);
}

function paperMetadataPatch(paperEnrichment: PaperMetadata | null): Record<string, unknown> | undefined {
	return paperEnrichment ? { type: 'paper', data: paperEnrichment } : undefined;
}

function shouldAcquireContent(target: WorkflowTarget, article: Article): boolean {
	const hasContent = 'has_content' in article && !!article.has_content;
	if (target.kind === 'userFile') return !hasContent && !article.storage_key && !!article.url;
	if (target.kind === 'article' && target.reacquire) {
		return (
			!!article.url && !article.storage_key && (!article.source_type || article.source_type === 'rss' || article.source_type === 'default')
		);
	}
	return target.kind === 'source' && (article.source_type === 'rss' || article.source_type === 'default');
}

function sourceArticleBase(article: Article, fallback: SourceArticleRecord): SourceArticleRecord {
	return {
		...fallback,
		url: article.url || fallback.url,
		title: article.title || fallback.title,
		source: article.source || fallback.source,
		publishedDate: article.published_date || fallback.publishedDate,
		summary: article.summary ?? fallback.summary,
		sourceType: article.source_type || fallback.sourceType,
		content: article.content ?? fallback.content,
		platformMetadata: article.platform_metadata ?? fallback.platformMetadata,
		tags: article.tags?.length ? article.tags : fallback.tags,
		keywords: article.keywords?.length ? article.keywords : fallback.keywords,
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

async function stageOgImagePatch(step: WorkflowStep, article: Article, acquiredContent: AcquiredContent | null): Promise<OgImagePatch> {
	if (article.og_image_url || !article.url || article.file_type === PDF_MIME) return EMPTY_OG_IMAGE_PATCH;
	if (acquiredContent?.ogImage?.ogImageUrl) return acquiredContent.ogImage;
	return step.do('resolve-og-image', { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '30 seconds' }, () =>
		fetchOgImage(article.url),
	);
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
	ogImagePatch: OgImagePatch,
	youtubeTranscript: YoutubeTranscript | undefined,
	youtubeHighlights: Awaited<ReturnType<typeof prepareYouTubeHighlights>>,
): Promise<string> {
	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	await db.query('BEGIN');
	try {
		let articleId: string;
		const ogPayload = ogImageUpdatePayload(ogImagePatch);
		if (target.kind === 'source') {
			const acquiredPayload = acquiredContentUpdatePayload(acquiredContent);
			const acquiredMetadataPatch = acquiredPayload.platform_metadata;
			const ogMetadataPatch = ogPayload.platform_metadata;
			const updatePayload = buildProcessorUpdatePayload(
				article,
				result,
				embedding,
				mergeMetadataPatch(acquiredMetadataPatch, ogMetadataPatch, paperMetadataPatch(paperEnrichment)),
			);
			Object.assign(updatePayload, withoutPlatformMetadata(acquiredPayload), withoutPlatformMetadata(ogPayload));
			const platformMetadata = updatePayload.platform_metadata ?? article.platform_metadata;
			const entities = normalizeArticleEntityUpdatePayload(updatePayload, article.source, platformMetadata);
			articleId = await insertFinalSourceArticle(db, sourceArticleBase(article, target.draft.article), updatePayload);
			if (entities) await syncArticleEntities(db, articleId, entities, article.source, platformMetadata);
		} else {
			const finalResult =
				pdfTextArtifact?.text && article.content ? { ...result, updateData: { ...result.updateData, content: article.content } } : result;
			const extraction = pdfTextArtifact ? pdfExtractionMetadata(pdfTextArtifact) : acquiredContent?.extraction;
			const metadataPatch = mergeMetadataPatch(
				extraction ? { extraction } : undefined,
				ogPayload.platform_metadata,
				paperMetadataPatch(paperEnrichment),
			);
			const updatePayload = {
				...withoutPlatformMetadata(
					acquiredContentUpdatePayload(acquiredContent, { preserveSourceType: target.kind === 'article' && target.reacquire }),
				),
				...buildProcessorUpdatePayload(article, finalResult, embedding, metadataPatch),
				...withoutPlatformMetadata(ogPayload),
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
		const acquiredContent = shouldAcquireContent(target, initialArticle)
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
		const ogImagePatch = await stageOgImagePatch(step, article, acquiredContent);

		const processorResult = await step.do(
			'ai-analysis',
			{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '600 seconds' },
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
					ogImagePatch,
					youtubeTranscript,
					youtubeHighlights,
				),
		);

		await syncPaperGraphForEnrichment(this.env, step, articleId, paperEnrichment);

		console.info({ tag: 'WORKFLOW', msg: 'Completed', article_id: articleId, ...logContext });
		return { success: true, article_id: articleId };
	}
}
