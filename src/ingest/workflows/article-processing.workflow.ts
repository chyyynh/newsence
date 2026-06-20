import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { measureImageDimensions } from '@media/dimensions';
import {
	ARTICLES_TABLE,
	loadProcessableArticle,
	loadProcessableArticleShell,
	type ProcessableArticleShell,
	type ProcessableTable,
	USER_FILES_TABLE,
} from '@shared/article-store';
import { generateArticleEmbedding } from '@shared/embedding';
import { hasOgDimensions } from '@shared/platform-metadata';
import {
	cleanupSourceArticleDraftRef,
	readSourceArticleDraft,
	type SourceArticleDraft,
	sourceDraftToArticle,
	sourceDraftYoutubeTranscript,
} from '@shared/source-draft';
import type { Article, Env } from '@shared/types';
import { isExtractablePdfFile } from '@shared/upload';
import { BROWSER_UA, decodeHtmlEntities, fetchWithTimeout, type TranscriptSegment } from '@shared/web';
import type { WorkflowQueueTarget } from '@shared/workflow-queue';
import { buildEmbeddingTextForArticle, type ProcessorResult, runArticleProcessor } from '../domain/processors';
import {
	prepareYouTubeHighlights,
	prepareYouTubeHighlightsFromTranscript,
	type YouTubeHighlightsUpdate,
} from '../platforms/youtube/highlights';
import { persistWorkflowTarget, recordWorkflowFailure } from './article-persistence';
import { createPdfTextTemp, deletePdfTextTemp, type PdfTextTempResult, readPdfTextTemp } from './pdf-text-temp';

const OG_FETCH_TIMEOUT_MS = 6_000;
const OG_MAX_BYTES = 131_072;

type WorkflowParams = {
	target: WorkflowQueueTarget;
};

type WorkflowRunContext = {
	target: WorkflowQueueTarget;
	table: ProcessableTable;
	readSourceDraft(): Promise<SourceArticleDraft>;
	readSourceArticle(): Promise<Article>;
};
type OgImageResult = {
	ogImageUrl: string | null;
	ogImageWidth: number | null;
	ogImageHeight: number | null;
};
type OgImageDimensions = Awaited<ReturnType<typeof measureImageDimensions>>;
type OgImagePatch = {
	ogImageUrl: string | null;
	ogImageDimensions: OgImageDimensions | null;
};
type YoutubeHighlightsInput =
	| { kind: 'transcript'; videoId: string; segments: TranscriptSegment[] }
	| { kind: 'article'; article: Article };

const EMPTY_OG_IMAGE_PATCH: OgImagePatch = { ogImageUrl: null, ogImageDimensions: null };

async function fetchOgImage(url: string): Promise<OgImageResult | null> {
	try {
		const response = await fetchWithTimeout(
			url,
			{
				headers: {
					'User-Agent': BROWSER_UA,
					Accept: 'text/html,application/xhtml+xml',
				},
			},
			OG_FETCH_TIMEOUT_MS,
		);

		if (!response.ok || !response.body) {
			await response.body?.cancel();
			return null;
		}

		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let totalBytes = 0;

		while (totalBytes < OG_MAX_BYTES) {
			const { done, value } = await reader.read();
			if (done || !value) break;
			chunks.push(value);
			totalBytes += value.length;
		}
		await reader.cancel();

		const html = new TextDecoder().decode(chunks.length === 1 ? chunks[0] : mergeChunks(chunks, totalBytes));
		let ogImageUrl = extractMeta(html, 'og:image') || extractMeta(html, 'og:image:url') || extractMetaName(html, 'twitter:image');
		if (!ogImageUrl) return null;

		if (!ogImageUrl.startsWith('http')) {
			try {
				ogImageUrl = new URL(ogImageUrl, url).toString();
			} catch {
				return null;
			}
		}
		if (/^http:\/\//i.test(ogImageUrl)) {
			ogImageUrl = ogImageUrl.replace(/^http:/i, 'https:');
		}

		const rawW = extractMeta(html, 'og:image:width');
		const rawH = extractMeta(html, 'og:image:height');

		return {
			ogImageUrl,
			ogImageWidth: parsePositiveInt(rawW),
			ogImageHeight: parsePositiveInt(rawH),
		};
	} catch {
		return null;
	}
}

function parsePositiveInt(raw: string | null): number | null {
	if (!raw) return null;
	const parsed = parseInt(raw, 10);
	return parsed > 0 ? parsed : null;
}

function mergeChunks(chunks: Uint8Array[], total: number): Uint8Array {
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.length;
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

function targetTable(target: WorkflowQueueTarget): ProcessableTable {
	return target.kind === 'row' ? (target.targetTable ?? ARTICLES_TABLE) : ARTICLES_TABLE;
}

function createWorkflowRunContext(env: Env, target: WorkflowQueueTarget): WorkflowRunContext {
	let draft: Promise<SourceArticleDraft> | undefined;
	let article: Promise<Article> | undefined;

	const readSourceDraft = () => {
		if (target.kind !== 'source') throw new Error('Source draft requested for row workflow target');
		draft ??= readSourceArticleDraft(env, target.sourceArticle).catch((error) => {
			draft = undefined;
			article = undefined;
			throw error;
		});
		return draft;
	};

	return {
		target,
		table: targetTable(target),
		readSourceDraft,
		readSourceArticle: () => {
			article ??= readSourceDraft().then(sourceDraftToArticle);
			return article;
		},
	};
}

function targetLogContext(context: WorkflowRunContext, article: Article): Record<string, string> {
	return context.target.kind === 'row'
		? { article_id: context.target.articleId, table: context.table }
		: { url: article.url, table: context.table };
}

async function loadTargetArticle(env: Env, context: WorkflowRunContext): Promise<Article> {
	if (context.target.kind === 'source') return context.readSourceArticle();
	return loadProcessableArticle(env, context.table, context.target.articleId);
}

async function loadTargetShell(env: Env, context: WorkflowRunContext): Promise<ProcessableArticleShell> {
	if (context.target.kind !== 'source') return loadProcessableArticleShell(env, context.table, context.target.articleId);
	return { ...(await context.readSourceArticle()), content: null };
}

async function withPdfTextTemp(env: Env, article: Article, pdfTextTemp: PdfTextTempResult | null): Promise<Article> {
	if (!pdfTextTemp?.textStorageKey) return article;
	return { ...article, content: await readPdfTextTemp(env, pdfTextTemp.textStorageKey) };
}

async function loadFullTargetArticle(env: Env, context: WorkflowRunContext, pdfTextTemp: PdfTextTempResult | null): Promise<Article> {
	return withPdfTextTemp(env, await loadTargetArticle(env, context), pdfTextTemp);
}

async function analyzeArticle(env: Env, context: WorkflowRunContext, sourceType: string, pdfTextTemp: PdfTextTempResult | null) {
	const article = await loadFullTargetArticle(env, context, pdfTextTemp);
	return runArticleProcessor(article, sourceType, { env, table: context.table });
}

async function generateWorkflowEmbedding(
	env: Env,
	context: WorkflowRunContext,
	processorResult: ProcessorResult,
	pdfTextTemp: PdfTextTempResult | null,
): Promise<number[] | null> {
	const article = await loadFullTargetArticle(env, context, pdfTextTemp);
	const text = buildEmbeddingTextForArticle(article, processorResult);
	return text && env.AI ? generateArticleEmbedding(text, env.AI) : null;
}

async function stagePdfExtraction(
	env: Env,
	context: WorkflowRunContext,
	article: ProcessableArticleShell,
	step: WorkflowStep,
): Promise<PdfTextTempResult | null> {
	const { target, table } = context;
	if (
		target.kind !== 'row' ||
		table !== USER_FILES_TABLE ||
		article.has_content ||
		!isExtractablePdfFile({ originType: article.origin_type, fileType: article.file_type, storageKey: article.storage_key })
	) {
		return null;
	}

	try {
		const pdfTextTemp = (await step.do(
			'extract-pdf-text',
			{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
			() => createPdfTextTemp(env, target.articleId, article.storage_key as string),
		)) as PdfTextTempResult;
		console.info({
			tag: 'WORKFLOW',
			msg: 'PDF extraction staged',
			article_id: target.articleId,
			status: pdfTextTemp.status,
			chars: pdfTextTemp.chars,
		});
		return pdfTextTemp;
	} catch (error) {
		console.warn({
			tag: 'WORKFLOW',
			msg: 'PDF extraction failed, continuing without content',
			article_id: target.articleId,
			error: String(error),
		});
		return { status: 'failed', chars: 0, pages: 0 };
	}
}

function mergeProcessorResult(result: ProcessorResult, { ogImageUrl, ogImageDimensions }: OgImagePatch): ProcessorResult {
	return {
		...result,
		updateData: {
			...result.updateData,
			...(ogImageUrl ? { og_image_url: ogImageUrl } : {}),
		},
		...(ogImageDimensions ? { ogImageDimensions } : {}),
	};
}

async function resolveWorkflowOgImagePatch(env: Env, article: Article, result: ProcessorResult, step: WorkflowStep): Promise<OgImagePatch> {
	if (!shouldResolveOgImagePatch(article, result)) return EMPTY_OG_IMAGE_PATCH;
	return (await step.do('resolve-og-image', { retries: { limit: 1, delay: '3 seconds' }, timeout: '25 seconds' }, () =>
		resolveOgImagePatch(env, article, result),
	)) as OgImagePatch;
}

function shouldResolveOgImagePatch(article: Article, result: ProcessorResult): boolean {
	const knownOgImageUrl = result.updateData.og_image_url ?? article.og_image_url ?? null;
	return !knownOgImageUrl || !hasOgDimensions(article.platform_metadata);
}

async function resolveOgImagePatch(env: Env, article: Article, result: ProcessorResult): Promise<OgImagePatch> {
	const fetchedOgImage = !article.og_image_url && !result.updateData.og_image_url ? await fetchOgImage(article.url) : null;

	const effectiveOgImageUrl = result.updateData.og_image_url ?? article.og_image_url ?? fetchedOgImage?.ogImageUrl ?? null;
	const ogImageDimensions = await resolveOgImageDimensions(env, article, effectiveOgImageUrl, fetchedOgImage);

	return { ogImageUrl: fetchedOgImage?.ogImageUrl ?? null, ogImageDimensions };
}

async function resolveOgImageDimensions(
	env: Env,
	article: Article,
	ogImageUrl: string | null,
	fetchedOgImage: OgImageResult | null,
): Promise<OgImageDimensions | null> {
	if (!ogImageUrl || hasOgDimensions(article.platform_metadata)) return null;

	if (fetchedOgImage?.ogImageUrl === ogImageUrl && fetchedOgImage.ogImageWidth && fetchedOgImage.ogImageHeight) {
		return { width: fetchedOgImage.ogImageWidth, height: fetchedOgImage.ogImageHeight };
	}

	return measureImageDimensions(env, ogImageUrl);
}

async function prepareYoutubeHighlights(
	env: Env,
	context: WorkflowRunContext,
	article: Article,
	sourceType: string,
	step: WorkflowStep,
): Promise<YouTubeHighlightsUpdate | null> {
	const input = await prepareYoutubeHighlightsInput(context, article, sourceType);
	if (!input) return null;

	return (await step.do(
		'generate-youtube-highlights',
		{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
		() =>
			input.kind === 'transcript'
				? prepareYouTubeHighlightsFromTranscript(env, input.videoId, input.segments)
				: prepareYouTubeHighlights(env, input.article),
	)) as YouTubeHighlightsUpdate | null;
}

async function prepareYoutubeHighlightsInput(
	context: WorkflowRunContext,
	article: Article,
	sourceType: string,
): Promise<YoutubeHighlightsInput | null> {
	if (article.platform_metadata?.type !== 'youtube') return null;

	if (context.target.kind === 'source') {
		const draft = await context.readSourceDraft();
		const transcript = sourceDraftYoutubeTranscript(draft);
		if (!transcript) return null;
		return {
			kind: 'transcript',
			videoId: article.platform_metadata.data.videoId,
			segments: transcript.segments as TranscriptSegment[],
		};
	}

	return sourceType === 'youtube' ? { kind: 'article', article } : null;
}

async function cleanupTargetTemps(
	env: Env,
	context: WorkflowRunContext,
	pdfTextTemp: PdfTextTempResult | null,
	step: WorkflowStep,
): Promise<void> {
	const { target } = context;
	if (!pdfTextTemp?.textStorageKey && target.kind !== 'source') return;

	await step.do('cleanup-workflow-temp-objects', { retries: { limit: 1, delay: '5 seconds' }, timeout: '20 seconds' }, () =>
		cleanupWorkflowTempObjects(env, context, pdfTextTemp),
	);
}

async function cleanupWorkflowTempObjects(env: Env, context: WorkflowRunContext, pdfTextTemp: PdfTextTempResult | null): Promise<void> {
	const { target } = context;
	const failures: Array<{ object: string; key: string; error: string }> = [];
	const deleteTemp = async (object: string, key: string, deleteFn: () => Promise<void>) => {
		try {
			await deleteFn();
		} catch (error) {
			failures.push({ object, key, error: String(error) });
		}
	};

	if (pdfTextTemp?.textStorageKey) {
		await deleteTemp('pdf_text', pdfTextTemp.textStorageKey, () => deletePdfTextTemp(env, pdfTextTemp.textStorageKey!));
	}

	if (target.kind === 'source') {
		await cleanupSourceArticleDraftRef(env, target.sourceArticle, { reason: 'workflow completed', logTag: 'WORKFLOW' });
	}

	if (failures.length) console.warn({ tag: 'WORKFLOW', msg: 'Temp object cleanup incomplete', failures });
}

export class NewsenceMonitorWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
	async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
		const context = createWorkflowRunContext(this.env, event.payload.target);
		try {
			const article = (await step.do(
				context.target.kind === 'source' ? 'load-source-article-shell' : 'fetch-article-shell',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() => loadTargetShell(this.env, context),
			)) as ProcessableArticleShell;
			const sourceType = article.source_type ?? 'default';

			console.info({ tag: 'WORKFLOW', msg: 'Starting', sourceType, ...targetLogContext(context, article) });

			const pdfTextTemp = await stagePdfExtraction(this.env, context, article, step);

			const processorResult = (await step.do(
				'ai-analysis',
				{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '180 seconds' },
				() => analyzeArticle(this.env, context, sourceType, pdfTextTemp),
			)) as ProcessorResult;

			const embedding = (await step.do(
				'generate-embedding',
				{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
				() => generateWorkflowEmbedding(this.env, context, processorResult, pdfTextTemp),
			)) as number[] | null;

			const finalProcessorResult = mergeProcessorResult(
				processorResult,
				await resolveWorkflowOgImagePatch(this.env, article, processorResult, step),
			);

			const youtubeHighlights = await prepareYoutubeHighlights(this.env, context, article, sourceType, step);
			const articleId = (await step.do(
				context.target.kind === 'source' ? 'insert-final-article' : 'update-db',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() =>
					persistWorkflowTarget(this.env, context, {
						article,
						result: finalProcessorResult,
						embedding,
						pdfTextTemp,
						youtubeHighlights,
					}),
			)) as string;

			await cleanupTargetTemps(this.env, context, pdfTextTemp, step);

			console.info({ tag: 'WORKFLOW', msg: 'Completed', article_id: articleId, ...targetLogContext(context, article) });
			return { success: true, article_id: articleId };
		} catch (error) {
			await recordWorkflowFailure(this.env, context, error);
			throw error;
		}
	}
}
