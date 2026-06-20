import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { measureImageDimensions } from '@media/dimensions';
import {
	ARTICLES_TABLE,
	type DbClient,
	type InsertArticleData,
	type ProcessableTable,
	USER_FILES_TABLE,
	upsertYoutubeTranscript,
	withDbClient,
	withDbTransaction,
} from '@shared/db';
import { generateArticleEmbedding } from '@shared/embedding';
import { hasOgDimensions } from '@shared/platform-metadata';
import type { Article, Env } from '@shared/types';
import { isExtractablePdfFile } from '@shared/upload';
import { BROWSER_UA, decodeHtmlEntities, fetchWithTimeout, type TranscriptSegment } from '@shared/web';
import {
	deleteSourceArticleDraft,
	readSourceArticleDraft,
	type SourceArticleDraft,
	type WorkflowQueueTarget,
} from '@shared/workflow-queue';
import {
	buildEmbeddingTextForArticle,
	buildProcessorUpdatePayload,
	type ProcessorResult,
	persistProcessorResult,
	runArticleProcessor,
} from '../domain/processors';
import { upsertTwitterSourceEvent } from '../platforms/twitter/source-events';
import {
	prepareYouTubeHighlights,
	prepareYouTubeHighlightsFromTranscript,
	saveYouTubeHighlights,
	type YouTubeHighlightsUpdate,
} from '../platforms/youtube/highlights';
import { createPdfTextTemp, deletePdfTextTemp, type PdfTextTempResult, readPdfTextTemp } from './pdf-text-temp';

const OG_FETCH_TIMEOUT_MS = 6_000;
const OG_MAX_BYTES = 131_072;

const ARTICLE_FIELDS_FOR_ARTICLES =
	'id, title, title_cn, summary, summary_cn, content, url, source, source_type, published_date, tags, keywords, scraped_date, og_image_url, platform_metadata, entities';

const ARTICLE_FIELDS_FOR_USER_FILES =
	'id, title, title_cn, summary, summary_cn, extracted_text AS content, source_url AS url, site_name AS source, platform_type AS source_type, published_date, tags, keywords, created_at AS scraped_date, og_image_url, metadata AS platform_metadata, entities, storage_key, file_type, origin_type';

const ARTICLE_SHELL_FIELDS_FOR_ARTICLES =
	'id, title, title_cn, summary, summary_cn, NULL::text AS content, content IS NOT NULL AND length(content) > 0 AS has_content, url, source, source_type, published_date, tags, keywords, scraped_date, og_image_url, platform_metadata, entities';

const ARTICLE_SHELL_FIELDS_FOR_USER_FILES =
	'id, title, title_cn, summary, summary_cn, NULL::text AS content, extracted_text IS NOT NULL AND length(extracted_text) > 0 AS has_content, source_url AS url, site_name AS source, platform_type AS source_type, published_date, tags, keywords, created_at AS scraped_date, og_image_url, metadata AS platform_metadata, entities, storage_key, file_type, origin_type';

type WorkflowParams = {
	target: WorkflowQueueTarget;
};

type RowTarget = Extract<WorkflowQueueTarget, { kind: 'row' }>;
type SourceDraftReader = () => Promise<SourceArticleDraft>;
type WorkflowRunContext = {
	target: WorkflowQueueTarget;
	table: ProcessableTable;
	readSourceDraft: SourceDraftReader;
};
type ArticleShell = Article & { has_content?: boolean };
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
type ArticleAnalysisStepResult = {
	processorResult: ProcessorResult;
	embedding: number[] | null;
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

async function syncArticleEntities(
	db: DbClient,
	articleId: string,
	entities: Array<{ name: string; name_cn: string; type: string }>,
): Promise<void> {
	if (!entities.length) return;

	for (const entity of entities) {
		const canonical = entity.name.toLowerCase().trim();
		if (!canonical) continue;

		try {
			const result = await db.query(
				`INSERT INTO entities (canonical_name, name, name_cn, type)
				 VALUES ($1, $2, $3, $4)
				 ON CONFLICT (canonical_name) DO UPDATE SET
				   updated_at = NOW()
				 RETURNING id`,
				[canonical, entity.name, entity.name_cn, entity.type],
			);
			const entityId = result.rows[0]?.id;
			if (!entityId) continue;

			await db.query(`INSERT INTO article_entities (article_id, entity_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [articleId, entityId]);
		} catch (err) {
			console.error({ tag: 'ENTITIES', msg: 'Failed to sync entity', entity: entity.name, error: String(err) });
		}
	}

	console.info({ tag: 'ENTITIES', msg: 'Synced', articleId, count: entities.length });
}

function articleFieldsFor(table: ProcessableTable): string {
	return table === USER_FILES_TABLE ? ARTICLE_FIELDS_FOR_USER_FILES : ARTICLE_FIELDS_FOR_ARTICLES;
}

function articleShellFieldsFor(table: ProcessableTable): string {
	return table === USER_FILES_TABLE ? ARTICLE_SHELL_FIELDS_FOR_USER_FILES : ARTICLE_SHELL_FIELDS_FOR_ARTICLES;
}

function targetTable(target: WorkflowQueueTarget): ProcessableTable {
	return target.kind === 'row' ? (target.targetTable ?? ARTICLES_TABLE) : ARTICLES_TABLE;
}

function createWorkflowRunContext(env: Env, target: WorkflowQueueTarget): WorkflowRunContext {
	return { target, table: targetTable(target), readSourceDraft: createSourceDraftReader(env, target) };
}

function targetLogContext(context: WorkflowRunContext, article: Article): Record<string, string> {
	return context.target.kind === 'row'
		? { article_id: context.target.articleId, table: context.table }
		: { url: article.url, table: context.table };
}

function articleFromSourceDraft(draft: SourceArticleDraft): Article {
	const data = draft.article;
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
		og_image_url: data.ogImageUrl,
		platform_metadata: data.platformMetadata as Article['platform_metadata'],
	};
}

function createSourceDraftReader(env: Env, target: WorkflowQueueTarget): SourceDraftReader {
	let cached: Promise<SourceArticleDraft> | undefined;
	return async () => {
		if (target.kind !== 'source') throw new Error('Source draft requested for row workflow target');
		cached ??= readSourceArticleDraft(env, target.sourceArticle).catch((error) => {
			cached = undefined;
			throw error;
		});
		return cached;
	};
}

async function fetchArticle(env: Env, table: ProcessableTable, articleId: string, fields: string): Promise<Article> {
	return withDbClient(env, async (db) => {
		const result = await db.query(`SELECT ${fields} FROM ${table} WHERE id = $1`, [articleId]);
		if (result.rows.length === 0) throw new Error(`Failed to fetch article ${articleId}: not found`);
		return result.rows[0] as Article;
	});
}

async function loadTargetArticle(env: Env, context: WorkflowRunContext): Promise<Article> {
	if (context.target.kind === 'source') return articleFromSourceDraft(await context.readSourceDraft());
	return fetchArticle(env, context.table, context.target.articleId, articleFieldsFor(context.table));
}

async function loadTargetShell(env: Env, context: WorkflowRunContext): Promise<ArticleShell> {
	const article =
		context.target.kind === 'source'
			? articleFromSourceDraft(await context.readSourceDraft())
			: await fetchArticle(env, context.table, context.target.articleId, articleShellFieldsFor(context.table));
	return { ...article, content: null };
}

function extractionMetadata(pdfTextTemp: PdfTextTempResult | null): Record<string, unknown> | undefined {
	if (!pdfTextTemp) return undefined;
	return {
		extraction: {
			status: pdfTextTemp.status,
			parser: 'liteparse',
			...(pdfTextTemp.status === 'failed' ? {} : { chars: pdfTextTemp.chars, pages: pdfTextTemp.pages }),
		},
	};
}

async function withPdfTextTemp(env: Env, article: Article, pdfTextTemp: PdfTextTempResult | null): Promise<Article> {
	if (!pdfTextTemp?.textStorageKey) return article;
	return { ...article, content: await readPdfTextTemp(env, pdfTextTemp.textStorageKey) };
}

async function analyzeArticleAndGenerateEmbedding(
	env: Env,
	article: Article,
	sourceType: string,
	table: ProcessableTable,
): Promise<ArticleAnalysisStepResult> {
	const processorResult = await runArticleProcessor(article, sourceType, { env, table });
	const text = buildEmbeddingTextForArticle(article, processorResult);
	const embedding = text && env.AI ? await generateArticleEmbedding(text, env.AI) : null;
	return { processorResult, embedding };
}

async function stagePdfExtraction(
	env: Env,
	context: WorkflowRunContext,
	article: ArticleShell,
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
		if (!draft.youtubeTranscript) return null;
		return {
			kind: 'transcript',
			videoId: article.platform_metadata.data.videoId,
			segments: draft.youtubeTranscript.segments as TranscriptSegment[],
		};
	}

	return sourceType === 'youtube' ? { kind: 'article', article } : null;
}

async function insertFinalSourceArticle(
	db: DbClient,
	base: InsertArticleData,
	article: Article,
	result: ProcessorResult,
	embedding: number[] | null,
): Promise<string> {
	const updatePayload = buildProcessorUpdatePayload(article, result, embedding);
	const platformMetadata = updatePayload.platform_metadata ?? base.platformMetadata;
	const entities = updatePayload.entities ?? null;
	const inserted = await db.query<{ id: string }>(
		`INSERT INTO articles (
			url, title, title_cn, source, published_date, scraped_date, keywords, tags, tokens,
			summary, summary_cn, source_type, content, content_cn, og_image_url, platform_metadata, entities, embedding
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17::jsonb, $18)
		ON CONFLICT (url) DO NOTHING
		RETURNING id`,
		[
			base.url,
			base.title,
			updatePayload.title_cn ?? null,
			base.source,
			base.publishedDate,
			new Date(),
			updatePayload.keywords ?? base.keywords ?? [],
			updatePayload.tags ?? base.tags ?? [],
			[],
			updatePayload.summary ?? base.summary,
			updatePayload.summary_cn ?? null,
			base.sourceType,
			updatePayload.content ?? base.content,
			updatePayload.content_cn ?? null,
			updatePayload.og_image_url ?? base.ogImageUrl,
			platformMetadata ? JSON.stringify(platformMetadata) : null,
			entities ? JSON.stringify(entities) : null,
			updatePayload.embedding ?? null,
		],
	);
	const articleId =
		inserted.rows[0]?.id ?? (await db.query<{ id: string }>('SELECT id FROM articles WHERE url = $1 LIMIT 1', [base.url])).rows[0]?.id;
	if (!articleId) throw new Error(`Failed to insert finalized article for ${base.url}`);
	return articleId;
}

async function persistSourceTarget(
	env: Env,
	context: WorkflowRunContext,
	result: ProcessorResult,
	embedding: number[] | null,
	youtubeHighlights: YouTubeHighlightsUpdate | null,
): Promise<string> {
	const draft = await context.readSourceDraft();
	const fullArticle = articleFromSourceDraft(draft);
	return withDbTransaction(env, 'source article', async (db) => {
		const articleId = await insertFinalSourceArticle(db, draft.article, fullArticle, result, embedding);
		if (draft.youtubeTranscript) await upsertYoutubeTranscript(db, draft.youtubeTranscript);
		if (result.updateData.entities?.length) await syncArticleEntities(db, articleId, result.updateData.entities);
		if (youtubeHighlights) await saveYouTubeHighlights(db, youtubeHighlights);
		if (draft.twitterSourceEvent) {
			await upsertTwitterSourceEvent(db, draft.twitterSourceEvent.tweet, {
				articleId,
				eventType: draft.twitterSourceEvent.eventType,
				text: draft.twitterSourceEvent.text,
				media: draft.twitterSourceEvent.media,
				raw: draft.twitterSourceEvent.raw,
			});
		}
		return articleId;
	});
}

async function persistRowTarget(
	env: Env,
	target: RowTarget,
	table: ProcessableTable,
	article: Article,
	result: ProcessorResult,
	embedding: number[] | null,
	pdfTextTemp: PdfTextTempResult | null,
	youtubeHighlights: YouTubeHighlightsUpdate | null,
): Promise<string> {
	return withDbTransaction(env, 'row workflow', async (db) => {
		const extractedPdfText = pdfTextTemp?.textStorageKey ? await readPdfTextTemp(env, pdfTextTemp.textStorageKey) : null;
		const finalResult: ProcessorResult = {
			...result,
			updateData: {
				...result.updateData,
				...(extractedPdfText !== null ? { content: extractedPdfText } : {}),
			},
		};

		await persistProcessorResult(target.articleId, article, finalResult, { db, table }, embedding, extractionMetadata(pdfTextTemp));
		if (table !== USER_FILES_TABLE && finalResult.updateData.entities?.length)
			await syncArticleEntities(db, target.articleId, finalResult.updateData.entities);
		if (youtubeHighlights) await saveYouTubeHighlights(db, youtubeHighlights);
		return target.articleId;
	});
}

async function persistTarget(
	env: Env,
	context: WorkflowRunContext,
	article: Article,
	result: ProcessorResult,
	embedding: number[] | null,
	pdfTextTemp: PdfTextTempResult | null,
	youtubeHighlights: YouTubeHighlightsUpdate | null,
): Promise<string> {
	if (context.target.kind === 'source') return persistSourceTarget(env, context, result, embedding, youtubeHighlights);
	return persistRowTarget(env, context.target, context.table, article, result, embedding, pdfTextTemp, youtubeHighlights);
}

async function cleanupTargetTemps(
	env: Env,
	context: WorkflowRunContext,
	pdfTextTemp: PdfTextTempResult | null,
	step: WorkflowStep,
): Promise<void> {
	const { target } = context;
	if (!pdfTextTemp?.textStorageKey && !(target.kind === 'source' && 'r2Key' in target.sourceArticle)) return;

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

	if (target.kind === 'source' && 'r2Key' in target.sourceArticle) {
		await deleteTemp('source_draft', target.sourceArticle.r2Key, () => deleteSourceArticleDraft(env, target.sourceArticle));
	}

	if (failures.length) console.warn({ tag: 'WORKFLOW', msg: 'Temp object cleanup incomplete', failures });
}

export class NewsenceMonitorWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
	async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
		const context = createWorkflowRunContext(this.env, event.payload.target);
		const article = (await step.do(
			context.target.kind === 'source' ? 'load-source-article-shell' : 'fetch-article-shell',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			() => loadTargetShell(this.env, context),
		)) as ArticleShell;
		const sourceType = article.source_type ?? 'default';

		console.info({ tag: 'WORKFLOW', msg: 'Starting', sourceType, ...targetLogContext(context, article) });

		const pdfTextTemp = await stagePdfExtraction(this.env, context, article, step);

		const { processorResult, embedding } = (await step.do(
			'ai-analysis',
			{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '180 seconds' },
			async () => {
				const fullArticle = await withPdfTextTemp(this.env, await loadTargetArticle(this.env, context), pdfTextTemp);
				return analyzeArticleAndGenerateEmbedding(this.env, fullArticle, sourceType, context.table);
			},
		)) as ArticleAnalysisStepResult;

		const finalProcessorResult = mergeProcessorResult(
			processorResult,
			await resolveWorkflowOgImagePatch(this.env, article, processorResult, step),
		);

		const youtubeHighlights = await prepareYoutubeHighlights(this.env, context, article, sourceType, step);
		const articleId = (await step.do(
			context.target.kind === 'source' ? 'insert-final-article' : 'update-db',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			() => persistTarget(this.env, context, article, finalProcessorResult, embedding, pdfTextTemp, youtubeHighlights),
		)) as string;

		await cleanupTargetTemps(this.env, context, pdfTextTemp, step);

		console.info({ tag: 'WORKFLOW', msg: 'Completed', article_id: articleId, ...targetLogContext(context, article) });
		return { success: true, article_id: articleId };
	}
}
