import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { measureImageDimensions } from '@media/dimensions';
import {
	ARTICLES_TABLE,
	createDbClient,
	type InsertArticleData,
	type ProcessableTable,
	resolveProcessableTable,
	SOURCE_ARTICLE_DRAFT_PREFIX,
	type SourceArticleDraft,
	type SourceArticleRef,
	USER_FILES_TABLE,
	upsertYoutubeTranscript,
} from '@shared/db';
import { generateArticleEmbedding } from '@shared/embedding';
import { hasOgDimensions } from '@shared/platform-metadata';
import type { Article, Env } from '@shared/types';
import { isExtractablePdfFile } from '@shared/upload';
import type { TranscriptSegment } from '@shared/web';
import { syncArticleEntities } from '../domain/entities';
import {
	buildEmbeddingTextForArticle,
	buildProcessorUpdatePayload,
	type ProcessorResult,
	persistProcessorResult,
	runArticleProcessor,
} from '../domain/processors';
import { upsertTwitterSourceEvent } from '../platforms/twitter/source-events';
import { fetchOgImage } from '../platforms/web-og';
import {
	prepareYouTubeHighlights,
	prepareYouTubeHighlightsFromTranscript,
	saveYouTubeHighlights,
	type YouTubeHighlightsUpdate,
} from '../platforms/youtube/highlights';
import { deletePdfTextArtifact, extractPdfToTextArtifact, type PdfExtractionResult, readPdfTextArtifact } from './pdf-extraction';

const ARTICLE_FIELDS_FOR_ARTICLES =
	'id, title, title_cn, summary, summary_cn, content, url, source, source_type, published_date, tags, keywords, scraped_date, og_image_url, platform_metadata, entities';

const ARTICLE_FIELDS_FOR_USER_FILES =
	'id, title, title_cn, summary, summary_cn, extracted_text AS content, source_url AS url, site_name AS source, platform_type AS source_type, published_date, tags, keywords, created_at AS scraped_date, og_image_url, metadata AS platform_metadata, entities, storage_key, file_type, origin_type';

const ARTICLE_SHELL_FIELDS_FOR_ARTICLES =
	'id, title, title_cn, summary, summary_cn, NULL::text AS content, content IS NOT NULL AND length(content) > 0 AS has_content, url, source, source_type, published_date, tags, keywords, scraped_date, og_image_url, platform_metadata, entities';

const ARTICLE_SHELL_FIELDS_FOR_USER_FILES =
	'id, title, title_cn, summary, summary_cn, NULL::text AS content, extracted_text IS NOT NULL AND length(extracted_text) > 0 AS has_content, source_url AS url, site_name AS source, platform_type AS source_type, published_date, tags, keywords, created_at AS scraped_date, og_image_url, metadata AS platform_metadata, entities, storage_key, file_type, origin_type';

const EMBEDDING_FIELDS_FOR_ARTICLES = 'id, title, summary, content, tags, keywords';
const EMBEDDING_FIELDS_FOR_USER_FILES = 'id, title, summary, extracted_text AS content, tags, keywords';

type WorkflowParams = {
	article_id?: string;
	source_article?: SourceArticleRef;
	target_table?: ProcessableTable;
};

type RowWorkflowTarget = {
	kind: 'row';
	articleId: string;
	table: ProcessableTable;
	isUserFile: boolean;
};

type SourceWorkflowTarget = {
	kind: 'source';
	sourceArticle: SourceArticleRef;
};

type WorkflowTarget = RowWorkflowTarget | SourceWorkflowTarget;
type ArticleShell = Article & { has_content?: boolean };

function articleFieldsFor(table: ProcessableTable): string {
	return table === USER_FILES_TABLE ? ARTICLE_FIELDS_FOR_USER_FILES : ARTICLE_FIELDS_FOR_ARTICLES;
}

function articleShellFieldsFor(table: ProcessableTable): string {
	return table === USER_FILES_TABLE ? ARTICLE_SHELL_FIELDS_FOR_USER_FILES : ARTICLE_SHELL_FIELDS_FOR_ARTICLES;
}

function embeddingFieldsFor(table: ProcessableTable): string {
	return table === USER_FILES_TABLE ? EMBEDDING_FIELDS_FOR_USER_FILES : EMBEDDING_FIELDS_FOR_ARTICLES;
}

function workflowTargetFromPayload(payload: WorkflowParams): WorkflowTarget {
	if (payload.source_article) return { kind: 'source', sourceArticle: payload.source_article };
	if (!payload.article_id) throw new Error('article_id is required');

	const table = resolveProcessableTable(payload.target_table);
	return {
		kind: 'row',
		articleId: payload.article_id,
		table,
		isUserFile: table === USER_FILES_TABLE,
	};
}

function targetTable(target: WorkflowTarget): ProcessableTable {
	return target.kind === 'row' ? target.table : ARTICLES_TABLE;
}

function targetLogContext(target: WorkflowTarget, article: Article): Record<string, string> {
	return target.kind === 'row' ? { article_id: target.articleId, table: target.table } : { url: article.url, table: ARTICLES_TABLE };
}

async function fetchArticle(env: Env, table: ProcessableTable, articleId: string, fields: string): Promise<Article> {
	const db = await createDbClient(env);
	try {
		const result = await db.query(`SELECT ${fields} FROM ${table} WHERE id = $1`, [articleId]);
		if (result.rows.length === 0) throw new Error(`Failed to fetch article ${articleId}: not found`);
		return result.rows[0] as Article;
	} finally {
		await db.end();
	}
}

async function readSourceArticleDraft(env: Env, ref: SourceArticleRef): Promise<SourceArticleDraft> {
	if ('inline' in ref) return ref.inline;
	if (!ref.r2Key.startsWith(SOURCE_ARTICLE_DRAFT_PREFIX)) throw new Error(`Invalid source article draft key: ${ref.r2Key}`);
	const obj = await env.R2.get(ref.r2Key);
	if (!obj) throw new Error(`Source article draft missing: ${ref.r2Key}`);
	return JSON.parse(await obj.text()) as SourceArticleDraft;
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

async function loadTargetArticle(env: Env, target: WorkflowTarget, fieldsForRow: string): Promise<Article> {
	if (target.kind === 'source') return articleFromSourceDraft(await readSourceArticleDraft(env, target.sourceArticle));
	return fetchArticle(env, target.table, target.articleId, fieldsForRow);
}

async function loadTargetShell(env: Env, target: WorkflowTarget): Promise<ArticleShell> {
	const article =
		target.kind === 'source'
			? articleFromSourceDraft(await readSourceArticleDraft(env, target.sourceArticle))
			: await fetchArticle(env, target.table, target.articleId, articleShellFieldsFor(target.table));
	return { ...article, content: null };
}

function extractionMetadata(extraction: PdfExtractionResult | null): Record<string, unknown> | undefined {
	if (!extraction) return undefined;
	return {
		extraction: {
			status: extraction.status,
			parser: 'liteparse',
			...(extraction.status === 'failed' ? {} : { chars: extraction.chars, pages: extraction.pages }),
		},
	};
}

async function withPdfExtractionText(env: Env, article: Article, extraction: PdfExtractionResult | null): Promise<Article> {
	if (!extraction?.textStorageKey) return article;
	return { ...article, content: await readPdfTextArtifact(env, extraction.textStorageKey) };
}

async function stagePdfExtraction(
	env: Env,
	target: WorkflowTarget,
	article: ArticleShell,
	step: WorkflowStep,
): Promise<PdfExtractionResult | null> {
	if (
		target.kind !== 'row' ||
		!target.isUserFile ||
		article.has_content ||
		!isExtractablePdfFile({ originType: article.origin_type, fileType: article.file_type, storageKey: article.storage_key })
	) {
		return null;
	}

	try {
		const extraction = (await step.do(
			'extract-pdf-text',
			{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
			() => extractPdfToTextArtifact(env, target.articleId, article.storage_key as string),
		)) as PdfExtractionResult;
		console.info({
			tag: 'WORKFLOW',
			msg: 'PDF extraction staged',
			article_id: target.articleId,
			status: extraction.status,
			chars: extraction.chars,
		});
		return extraction;
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

function mergeProcessorResult(
	result: ProcessorResult,
	fetchedOgImageUrl: unknown,
	ogImageDimensions: Awaited<ReturnType<typeof measureImageDimensions>> | null,
): ProcessorResult {
	return {
		...result,
		updateData: {
			...result.updateData,
			...(typeof fetchedOgImageUrl === 'string' ? { og_image_url: fetchedOgImageUrl } : {}),
		},
		...(ogImageDimensions ? { ogImageDimensions } : {}),
	};
}

async function prepareYoutubeHighlights(
	env: Env,
	target: WorkflowTarget,
	article: Article,
	sourceType: string,
	step: WorkflowStep,
): Promise<YouTubeHighlightsUpdate | null> {
	if (article.platform_metadata?.type !== 'youtube') return null;

	if (target.kind === 'source') {
		return (await step.do(
			'generate-youtube-highlights',
			{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
			async () => {
				const draft = await readSourceArticleDraft(env, target.sourceArticle);
				if (!draft.youtubeTranscript) return null;
				return prepareYouTubeHighlightsFromTranscript(
					env,
					article.platform_metadata!.data.videoId,
					draft.youtubeTranscript.segments as TranscriptSegment[],
				);
			},
		)) as YouTubeHighlightsUpdate | null;
	}

	if (sourceType !== 'youtube') return null;
	return (await step.do(
		'generate-youtube-highlights',
		{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
		() => prepareYouTubeHighlights(env, article),
	)) as YouTubeHighlightsUpdate | null;
}

async function insertFinalSourceArticle(
	db: Awaited<ReturnType<typeof createDbClient>>,
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
	target: SourceWorkflowTarget,
	result: ProcessorResult,
	embedding: number[] | null,
	youtubeHighlights: YouTubeHighlightsUpdate | null,
): Promise<string> {
	const draft = await readSourceArticleDraft(env, target.sourceArticle);
	const fullArticle = articleFromSourceDraft(draft);
	const db = await createDbClient(env);
	try {
		await db.query('BEGIN');
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
		await db.query('COMMIT');
		return articleId;
	} catch (error) {
		await db
			.query('ROLLBACK')
			.catch((rollbackError) => console.error({ tag: 'WORKFLOW', msg: 'source article rollback failed', error: String(rollbackError) }));
		throw error;
	} finally {
		await db.end();
	}
}

async function persistRowTarget(
	env: Env,
	target: RowWorkflowTarget,
	article: Article,
	result: ProcessorResult,
	embedding: number[] | null,
	pdfExtraction: PdfExtractionResult | null,
	youtubeHighlights: YouTubeHighlightsUpdate | null,
): Promise<string> {
	const db = await createDbClient(env);
	try {
		await db.query('BEGIN');
		const extractedPdfText = pdfExtraction?.textStorageKey ? await readPdfTextArtifact(env, pdfExtraction.textStorageKey) : null;
		const finalResult: ProcessorResult = {
			...result,
			updateData: {
				...result.updateData,
				...(extractedPdfText !== null ? { content: extractedPdfText } : {}),
			},
		};

		await persistProcessorResult(
			target.articleId,
			article,
			finalResult,
			{ db, table: target.table },
			embedding,
			extractionMetadata(pdfExtraction),
		);
		if (!target.isUserFile && finalResult.updateData.entities?.length)
			await syncArticleEntities(db, target.articleId, finalResult.updateData.entities);
		if (youtubeHighlights) await saveYouTubeHighlights(db, youtubeHighlights);
		await db.query('COMMIT');
		return target.articleId;
	} catch (error) {
		await db
			.query('ROLLBACK')
			.catch((rollbackError) => console.error({ tag: 'WORKFLOW', msg: 'row workflow rollback failed', error: String(rollbackError) }));
		throw error;
	} finally {
		await db.end();
	}
}

async function persistTarget(
	env: Env,
	target: WorkflowTarget,
	article: Article,
	result: ProcessorResult,
	embedding: number[] | null,
	pdfExtraction: PdfExtractionResult | null,
	youtubeHighlights: YouTubeHighlightsUpdate | null,
): Promise<string> {
	if (target.kind === 'source') return persistSourceTarget(env, target, result, embedding, youtubeHighlights);
	return persistRowTarget(env, target, article, result, embedding, pdfExtraction, youtubeHighlights);
}

async function cleanupTargetArtifacts(
	env: Env,
	target: WorkflowTarget,
	pdfExtraction: PdfExtractionResult | null,
	step: WorkflowStep,
): Promise<void> {
	if (pdfExtraction?.textStorageKey) {
		await step.do('cleanup-pdf-text-artifact', { retries: { limit: 2, delay: '5 seconds' }, timeout: '15 seconds' }, () =>
			deletePdfTextArtifact(env, pdfExtraction.textStorageKey!),
		);
	}

	if (target.kind === 'source' && 'r2Key' in target.sourceArticle) {
		await step.do('cleanup-source-article-draft', { retries: { limit: 2, delay: '5 seconds' }, timeout: '15 seconds' }, () =>
			env.R2.delete(target.sourceArticle.r2Key),
		);
	}
}

export class NewsenceMonitorWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
	async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
		const target = workflowTargetFromPayload(event.payload);
		const article = (await step.do(
			target.kind === 'source' ? 'load-source-article-shell' : 'fetch-article-shell',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			() => loadTargetShell(this.env, target),
		)) as ArticleShell;
		const sourceType = article.source_type ?? 'default';

		console.info({ tag: 'WORKFLOW', msg: 'Starting', sourceType, ...targetLogContext(target, article) });

		const pdfExtraction = await stagePdfExtraction(this.env, target, article, step);

		const processorResult = (await step.do(
			'ai-analysis',
			{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '180 seconds' },
			async () => {
				const fullArticle = await withPdfExtractionText(
					this.env,
					await loadTargetArticle(this.env, target, articleFieldsFor(targetTable(target))),
					pdfExtraction,
				);
				return runArticleProcessor(fullArticle, sourceType, { env: this.env, table: targetTable(target) });
			},
		)) as ProcessorResult;

		const fetchedOgImageUrl =
			!article.og_image_url && !processorResult.updateData.og_image_url
				? await step.do('fetch-og-image', { retries: { limit: 1, delay: '3 seconds' }, timeout: '10 seconds' }, async () => {
						const ogResult = await fetchOgImage(article.url);
						return ogResult?.ogImageUrl ?? null;
					})
				: null;

		const effectiveOgImageUrl = processorResult.updateData.og_image_url ?? article.og_image_url ?? fetchedOgImageUrl;
		const ogImageDimensions =
			effectiveOgImageUrl && !hasOgDimensions(article.platform_metadata)
				? await step.do('measure-og-dimensions', { retries: { limit: 1, delay: '3 seconds' }, timeout: '15 seconds' }, async () =>
						measureImageDimensions(this.env, effectiveOgImageUrl),
					)
				: null;

		const finalProcessorResult = mergeProcessorResult(processorResult, fetchedOgImageUrl, ogImageDimensions);

		const embedding = (await step.do(
			'generate-embedding',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
			async () => {
				const embeddingArticle = await withPdfExtractionText(
					this.env,
					await loadTargetArticle(this.env, target, embeddingFieldsFor(targetTable(target))),
					pdfExtraction,
				);
				const text = buildEmbeddingTextForArticle(embeddingArticle, finalProcessorResult);
				if (!text || !this.env.AI) return null;
				return generateArticleEmbedding(text, this.env.AI);
			},
		)) as number[] | null;

		const youtubeHighlights = await prepareYoutubeHighlights(this.env, target, article, sourceType, step);
		const articleId = (await step.do(
			target.kind === 'source' ? 'insert-final-article' : 'update-db',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			() => persistTarget(this.env, target, article, finalProcessorResult, embedding, pdfExtraction, youtubeHighlights),
		)) as string;

		await cleanupTargetArtifacts(this.env, target, pdfExtraction, step);

		console.info({ tag: 'WORKFLOW', msg: 'Completed', article_id: articleId, ...targetLogContext(target, article) });
		return { success: true, article_id: articleId };
	}
}
