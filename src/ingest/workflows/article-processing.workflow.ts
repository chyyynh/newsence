import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { measureImageDimensions } from '@media/dimensions';
import { createDbClient, type ProcessableTable, resolveProcessableTable, USER_FILES_TABLE } from '@shared/db';
import { generateArticleEmbedding, saveArticleEmbedding } from '@shared/embedding';
import { hasOgDimensions } from '@shared/platform-metadata';
import type { Article, Env } from '@shared/types';
import { isExtractablePdfFile } from '@shared/upload';
import { syncArticleEntities } from '../domain/entities';
import { buildEmbeddingTextForArticle, type ProcessorResult, persistProcessorResult, runArticleProcessor } from '../domain/processors';
import { fetchOgImage } from '../platforms/web-og';
import { generateAndSaveYouTubeHighlights } from '../platforms/youtube/highlights';
import { extractAndPersistPdf, markExtractionFailed, type PdfExtractionResult } from './pdf-extraction';

const ARTICLE_FIELDS_FOR_ARTICLES =
	'id, title, title_cn, summary, summary_cn, content, url, source, source_type, published_date, tags, keywords, scraped_date, og_image_url, platform_metadata, entities';

// user_files carries the same editorial payload under different column names.
const ARTICLE_FIELDS_FOR_USER_FILES =
	'id, title, title_cn, summary, summary_cn, extracted_text AS content, source_url AS url, site_name AS source, platform_type AS source_type, published_date, tags, keywords, created_at AS scraped_date, og_image_url, metadata AS platform_metadata, entities, storage_key, file_type, origin_type';

const ARTICLE_SHELL_FIELDS_FOR_ARTICLES =
	'id, title, title_cn, summary, summary_cn, NULL::text AS content, url, source, source_type, published_date, tags, keywords, scraped_date, og_image_url, platform_metadata, entities';

const ARTICLE_SHELL_FIELDS_FOR_USER_FILES =
	'id, title, title_cn, summary, summary_cn, NULL::text AS content, source_url AS url, site_name AS source, platform_type AS source_type, published_date, tags, keywords, created_at AS scraped_date, og_image_url, metadata AS platform_metadata, entities, storage_key, file_type, origin_type';

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
	article_id: string;
	target_table?: ProcessableTable;
};

export class NewsenceMonitorWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
	async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
		const { article_id, target_table } = event.payload;
		const table = resolveProcessableTable(target_table);
		const isUserFile = table === USER_FILES_TABLE;

		console.info({ tag: 'WORKFLOW', msg: 'Starting', article_id, table });

		const article = (await step.do(
			'fetch-article-shell',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			() => fetchArticle(this.env, table, article_id, articleShellFieldsFor(table)),
		)) as Article;
		const sourceType = article.source_type ?? 'default';

		if (
			isUserFile &&
			!article.content &&
			isExtractablePdfFile({ originType: article.origin_type, fileType: article.file_type, storageKey: article.storage_key })
		) {
			const storageKey = article.storage_key as string;
			try {
				const extracted = (await step.do(
					'extract-pdf-text',
					{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
					() => extractAndPersistPdf(this.env, article_id, storageKey),
				)) as PdfExtractionResult;
				console.info({ tag: 'WORKFLOW', msg: 'PDF extraction persisted', article_id, status: extracted.status, chars: extracted.chars });
			} catch (error) {
				console.warn({ tag: 'WORKFLOW', msg: 'PDF extraction failed, continuing without content', article_id, error: String(error) });
				await step.do('flag-extraction-failed', { retries: { limit: 1, delay: '5 seconds' }, timeout: '15 seconds' }, () =>
					markExtractionFailed(this.env, article_id),
				);
			}
		}

		const processorResult = (await step.do(
			'ai-analysis',
			{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '180 seconds' },
			async () => {
				const processingArticle = await fetchArticle(this.env, table, article_id, articleFieldsFor(table));
				return runArticleProcessor(processingArticle, sourceType, {
					env: this.env,
					table,
				});
			},
		)) as ProcessorResult;

		if (!article.og_image_url && !processorResult.updateData.og_image_url) {
			const ogResult = await step.do('fetch-og-image', { retries: { limit: 1, delay: '3 seconds' }, timeout: '10 seconds' }, async () =>
				fetchOgImage(article.url),
			);
			if (ogResult?.ogImageUrl) {
				processorResult.updateData.og_image_url = ogResult.ogImageUrl;
			}
		}

		const effectiveOgImageUrl = processorResult.updateData.og_image_url ?? article.og_image_url;
		if (effectiveOgImageUrl && !hasOgDimensions(article.platform_metadata)) {
			const dims = await step.do('measure-og-dimensions', { retries: { limit: 1, delay: '3 seconds' }, timeout: '15 seconds' }, async () =>
				measureImageDimensions(this.env, effectiveOgImageUrl),
			);
			if (dims) {
				processorResult.ogImageDimensions = dims;
				console.info({ tag: 'WORKFLOW', msg: 'Measured OG image dimensions', article_id, ...dims });
			}
		}

		// Full-content translation is a display artifact, not canonical ingest data.
		await step.do('update-db', { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' }, async () => {
			const db = await createDbClient(this.env);
			try {
				await persistProcessorResult(article_id, article, processorResult, {
					db,
					table,
				});
				const fields = Object.keys(processorResult.updateData);
				if (fields.length > 0) console.info({ tag: 'WORKFLOW', msg: 'Updated fields', fields: fields.join(', ') });
				if (processorResult.enrichments && Object.keys(processorResult.enrichments).length > 0) {
					console.info({ tag: 'WORKFLOW', msg: 'Enrichments saved', enrichments: Object.keys(processorResult.enrichments).join(', ') });
				}
			} finally {
				await db.end();
			}
		});

		// article_entities FKs point at public articles only.
		if (!isUserFile && processorResult.updateData.entities?.length) {
			await step.do(
				'sync-entities',
				{ retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '15 seconds' },
				async () => {
					const db = await createDbClient(this.env);
					try {
						await syncArticleEntities(db, article_id, processorResult.updateData.entities!);
					} finally {
						await db.end();
					}
				},
			);
		}

		if (sourceType === 'youtube' && article.platform_metadata?.type === 'youtube') {
			await step.do(
				'generate-youtube-highlights',
				{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
				() => generateAndSaveYouTubeHighlights(this.env, article_id, article),
			);
		}

		await step.do(
			'generate-and-save-embedding',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
			async () => {
				const embeddingArticle = await fetchArticle(this.env, table, article_id, embeddingFieldsFor(table));
				const text = buildEmbeddingTextForArticle(embeddingArticle, processorResult);
				if (!text || !this.env.AI) return false;
				const embedding = await generateArticleEmbedding(text, this.env.AI);
				if (!embedding) return false;
				const db = await createDbClient(this.env);
				try {
					const saved = await saveArticleEmbedding(db, article_id, embedding, table);
					if (!saved) throw new Error(`Failed to save embedding for ${article_id}`);
					console.info({ tag: 'WORKFLOW', msg: 'Embedding saved', article_id });
					return true;
				} finally {
					await db.end();
				}
			},
		);

		console.info({ tag: 'WORKFLOW', msg: 'Completed', article_id });
		return { success: true, article_id };
	}
}
