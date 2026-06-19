import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { measureImageDimensions } from '@media/dimensions';
import {
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

// user_files carries the same editorial payload under different column names.
const ARTICLE_FIELDS_FOR_USER_FILES =
	'id, title, title_cn, summary, summary_cn, extracted_text AS content, source_url AS url, site_name AS source, platform_type AS source_type, published_date, tags, keywords, created_at AS scraped_date, og_image_url, metadata AS platform_metadata, entities, storage_key, file_type, origin_type';

const ARTICLE_SHELL_FIELDS_FOR_ARTICLES =
	'id, title, title_cn, summary, summary_cn, NULL::text AS content, content IS NOT NULL AND length(content) > 0 AS has_content, url, source, source_type, published_date, tags, keywords, scraped_date, og_image_url, platform_metadata, entities';

const ARTICLE_SHELL_FIELDS_FOR_USER_FILES =
	'id, title, title_cn, summary, summary_cn, NULL::text AS content, extracted_text IS NOT NULL AND length(extracted_text) > 0 AS has_content, source_url AS url, site_name AS source, platform_type AS source_type, published_date, tags, keywords, created_at AS scraped_date, og_image_url, metadata AS platform_metadata, entities, storage_key, file_type, origin_type';

const EMBEDDING_FIELDS_FOR_ARTICLES = 'id, title, summary, content, tags, keywords';
const EMBEDDING_FIELDS_FOR_USER_FILES = 'id, title, summary, extracted_text AS content, tags, keywords';

function articleFieldsFor(table: string): string {
	return table === USER_FILES_TABLE ? ARTICLE_FIELDS_FOR_USER_FILES : ARTICLE_FIELDS_FOR_ARTICLES;
}

function articleShellFieldsFor(table: string): string {
	return table === USER_FILES_TABLE ? ARTICLE_SHELL_FIELDS_FOR_USER_FILES : ARTICLE_SHELL_FIELDS_FOR_ARTICLES;
}

function embeddingFieldsFor(table: string): string {
	return table === USER_FILES_TABLE ? EMBEDDING_FIELDS_FOR_USER_FILES : EMBEDDING_FIELDS_FOR_ARTICLES;
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

type WorkflowParams = {
	article_id?: string;
	source_article?: SourceArticleRef;
	target_table?: ProcessableTable;
};

type ArticleShell = Article & { has_content?: boolean };

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

export class NewsenceMonitorWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
	async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
		if (event.payload.source_article) {
			return this.runSourceArticle(event.payload.source_article, step);
		}

		const { article_id, target_table } = event.payload;
		if (!article_id) throw new Error('article_id is required');
		const table = resolveProcessableTable(target_table);
		const isUserFile = table === USER_FILES_TABLE;

		console.info({ tag: 'WORKFLOW', msg: 'Starting', article_id, table });

		const article = (await step.do(
			'fetch-article-shell',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			() => fetchArticle(this.env, table, article_id, articleShellFieldsFor(table)),
		)) as ArticleShell;
		const sourceType = article.source_type ?? 'default';

		let pdfExtraction: PdfExtractionResult | null = null;
		if (
			isUserFile &&
			!article.has_content &&
			isExtractablePdfFile({ originType: article.origin_type, fileType: article.file_type, storageKey: article.storage_key })
		) {
			const storageKey = article.storage_key as string;
			try {
				pdfExtraction = (await step.do(
					'extract-pdf-text',
					{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
					() => extractPdfToTextArtifact(this.env, article_id, storageKey),
				)) as PdfExtractionResult;
				console.info({
					tag: 'WORKFLOW',
					msg: 'PDF extraction staged',
					article_id,
					status: pdfExtraction.status,
					chars: pdfExtraction.chars,
				});
			} catch (error) {
				console.warn({ tag: 'WORKFLOW', msg: 'PDF extraction failed, continuing without content', article_id, error: String(error) });
				pdfExtraction = { status: 'failed', chars: 0, pages: 0 };
			}
		}

		const processorResult = (await step.do(
			'ai-analysis',
			{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '180 seconds' },
			async () => {
				const processingArticle = await withPdfExtractionText(
					this.env,
					await fetchArticle(this.env, table, article_id, articleFieldsFor(table)),
					pdfExtraction,
				);
				return runArticleProcessor(processingArticle, sourceType, {
					env: this.env,
					table,
				});
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
		if (ogImageDimensions) {
			console.info({ tag: 'WORKFLOW', msg: 'Measured OG image dimensions', article_id, ...ogImageDimensions });
		}

		const embedding = (await step.do(
			'generate-embedding',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
			async () => {
				const embeddingArticle = await withPdfExtractionText(
					this.env,
					await fetchArticle(this.env, table, article_id, embeddingFieldsFor(table)),
					pdfExtraction,
				);
				const text = buildEmbeddingTextForArticle(embeddingArticle, processorResult);
				if (!text || !this.env.AI) return null;
				return generateArticleEmbedding(text, this.env.AI);
			},
		)) as number[] | null;

		const youtubeHighlightsUpdate =
			sourceType === 'youtube' && article.platform_metadata?.type === 'youtube'
				? ((await step.do(
						'generate-youtube-highlights',
						{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
						() => prepareYouTubeHighlights(this.env, article),
					)) as YouTubeHighlightsUpdate | null)
				: null;

		// Full-content translation is a display artifact, not canonical ingest data.
		await step.do('update-db', { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' }, async () => {
			const db = await createDbClient(this.env);
			try {
				const extractedPdfText = pdfExtraction?.textStorageKey ? await readPdfTextArtifact(this.env, pdfExtraction.textStorageKey) : null;
				const finalProcessorResult: ProcessorResult = {
					...processorResult,
					updateData: {
						...processorResult.updateData,
						...(extractedPdfText !== null ? { content: extractedPdfText } : {}),
						...(fetchedOgImageUrl ? { og_image_url: fetchedOgImageUrl } : {}),
					},
					...(ogImageDimensions ? { ogImageDimensions } : {}),
				};
				await persistProcessorResult(
					article_id,
					article,
					finalProcessorResult,
					{
						db,
						table,
					},
					embedding,
					extractionMetadata(pdfExtraction),
				);
				const fields = Object.keys(finalProcessorResult.updateData);
				if (fields.length > 0) console.info({ tag: 'WORKFLOW', msg: 'Updated fields', fields: fields.join(', ') });
				if (embedding?.length) console.info({ tag: 'WORKFLOW', msg: 'Embedding saved', article_id });
				if (finalProcessorResult.enrichments && Object.keys(finalProcessorResult.enrichments).length > 0) {
					console.info({
						tag: 'WORKFLOW',
						msg: 'Enrichments saved',
						enrichments: Object.keys(finalProcessorResult.enrichments).join(', '),
					});
				}
				// article_entities FKs point at public articles only.
				if (!isUserFile && finalProcessorResult.updateData.entities?.length) {
					await syncArticleEntities(db, article_id, finalProcessorResult.updateData.entities);
				}
				if (youtubeHighlightsUpdate) {
					await saveYouTubeHighlights(db, youtubeHighlightsUpdate);
					console.info({
						tag: 'WORKFLOW',
						msg: 'YouTube highlights saved',
						article_id,
						videoId: youtubeHighlightsUpdate.videoId,
						count: youtubeHighlightsUpdate.count,
					});
				}
			} finally {
				await db.end();
			}
		});

		if (pdfExtraction?.textStorageKey) {
			await step.do('cleanup-pdf-text-artifact', { retries: { limit: 2, delay: '5 seconds' }, timeout: '15 seconds' }, () =>
				deletePdfTextArtifact(this.env, pdfExtraction.textStorageKey!),
			);
		}

		console.info({ tag: 'WORKFLOW', msg: 'Completed', article_id });
		return { success: true, article_id };
	}

	private async runSourceArticle(sourceArticle: SourceArticleRef, step: WorkflowStep) {
		const article = (await step.do(
			'load-source-article-shell',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => {
				const draft = await readSourceArticleDraft(this.env, sourceArticle);
				return { ...articleFromSourceDraft(draft), content: null };
			},
		)) as Article;
		const sourceType = article.source_type ?? 'default';

		console.info({ tag: 'WORKFLOW', msg: 'Starting source article', url: article.url, sourceType });

		const processorResult = (await step.do(
			'ai-analysis',
			{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '180 seconds' },
			async () => {
				const draft = await readSourceArticleDraft(this.env, sourceArticle);
				return runArticleProcessor(articleFromSourceDraft(draft), sourceType, { env: this.env, table: 'articles' });
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

		const finalProcessorResult: ProcessorResult = {
			...processorResult,
			updateData: {
				...processorResult.updateData,
				...(fetchedOgImageUrl ? { og_image_url: fetchedOgImageUrl } : {}),
			},
			...(ogImageDimensions ? { ogImageDimensions } : {}),
		};

		const embedding = (await step.do(
			'generate-embedding',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
			async () => {
				const draft = await readSourceArticleDraft(this.env, sourceArticle);
				const text = buildEmbeddingTextForArticle(articleFromSourceDraft(draft), finalProcessorResult);
				if (!text || !this.env.AI) return null;
				return generateArticleEmbedding(text, this.env.AI);
			},
		)) as number[] | null;

		const youtubeHighlightsUpdate =
			article.platform_metadata?.type === 'youtube'
				? ((await step.do(
						'generate-youtube-highlights',
						{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
						async () => {
							const draft = await readSourceArticleDraft(this.env, sourceArticle);
							if (!draft.youtubeTranscript) return null;
							return prepareYouTubeHighlightsFromTranscript(
								this.env,
								article.platform_metadata!.data.videoId,
								draft.youtubeTranscript.segments as TranscriptSegment[],
							);
						},
					)) as YouTubeHighlightsUpdate | null)
				: null;

		const articleId = (await step.do(
			'insert-final-article',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => {
				const draft = await readSourceArticleDraft(this.env, sourceArticle);
				const fullArticle = articleFromSourceDraft(draft);
				const db = await createDbClient(this.env);
				try {
					await db.query('BEGIN');
					const finalizedArticleId = await insertFinalSourceArticle(db, draft.article, fullArticle, finalProcessorResult, embedding);
					if (draft.youtubeTranscript) await upsertYoutubeTranscript(db, draft.youtubeTranscript);
					if (finalProcessorResult.updateData.entities?.length) {
						await syncArticleEntities(db, finalizedArticleId, finalProcessorResult.updateData.entities);
					}
					if (youtubeHighlightsUpdate) await saveYouTubeHighlights(db, youtubeHighlightsUpdate);
					if (draft.twitterSourceEvent) {
						await upsertTwitterSourceEvent(db, draft.twitterSourceEvent.tweet, {
							articleId: finalizedArticleId,
							eventType: draft.twitterSourceEvent.eventType,
							text: draft.twitterSourceEvent.text,
							media: draft.twitterSourceEvent.media,
							raw: draft.twitterSourceEvent.raw,
						});
					}
					await db.query('COMMIT');
					return finalizedArticleId;
				} catch (error) {
					await db
						.query('ROLLBACK')
						.catch((rollbackError) =>
							console.error({ tag: 'WORKFLOW', msg: 'source article rollback failed', error: String(rollbackError) }),
						);
					throw error;
				} finally {
					await db.end();
				}
			},
		)) as string;

		if ('r2Key' in sourceArticle) {
			await step.do('cleanup-source-article-draft', { retries: { limit: 2, delay: '5 seconds' }, timeout: '15 seconds' }, () =>
				this.env.R2.delete(sourceArticle.r2Key),
			);
		}

		console.info({ tag: 'WORKFLOW', msg: 'Completed source article', article_id: articleId, url: article.url });
		return { success: true, article_id: articleId };
	}
}
