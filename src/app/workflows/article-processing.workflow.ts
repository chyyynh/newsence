import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { syncArticleEntities } from '../../domain/entities';
import {
	buildEmbeddingTextForArticle,
	type ProcessorResult,
	persistProcessorResult,
	runArticleProcessor,
	translateContent,
} from '../../domain/processing/processors';
import { ARTICLES_TABLE, createDbClient, USER_FILES_TABLE } from '../../infra/db';
import { generateArticleEmbedding, saveArticleEmbedding } from '../../infra/embedding';
import { logInfo, logWarn } from '../../infra/log';
import type { Article, Env } from '../../models/types';
import { fetchOgImage } from '../../platforms/web/scraper';
import { extractAndPersistPdf, isUploadedPdf } from './steps/pdf-extraction';
import { generateAndSaveYouTubeHighlights } from './steps/youtube-highlights';

const ARTICLE_FIELDS_FOR_ARTICLES =
	'id, title, title_cn, summary, summary_cn, content, url, source, source_type, published_date, tags, keywords, scraped_date, og_image_url, platform_metadata, entities';

// user_files carries the same editorial payload under different column names.
// Aliased so the in-memory `Article` shape stays consistent between tables.
const ARTICLE_FIELDS_FOR_USER_FILES =
	'id, title, title_cn, summary, summary_cn, extracted_text AS content, source_url AS url, site_name AS source, platform_type AS source_type, published_date, tags, keywords, created_at AS scraped_date, og_image_url, metadata AS platform_metadata, entities, storage_key, file_type, origin_type';

function articleFieldsFor(table: string): string {
	return table === USER_FILES_TABLE ? ARTICLE_FIELDS_FOR_USER_FILES : ARTICLE_FIELDS_FOR_ARTICLES;
}

type WorkflowParams = {
	article_id: string;
	source_type: string;
	target_table?: string;
};

export class NewsenceMonitorWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
	async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
		const { article_id, source_type, target_table } = event.payload;
		const table = target_table ?? ARTICLES_TABLE;
		const isUserFile = table === USER_FILES_TABLE;
		const fields = articleFieldsFor(table);

		logInfo('WORKFLOW', 'Starting', { article_id, source_type, table });

		// Step 1: Fetch article from DB
		const article = (await step.do(
			'fetch-article',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => {
				const db = await createDbClient(this.env);
				try {
					const result = await db.query(`SELECT ${fields} FROM ${table} WHERE id = $1`, [article_id]);
					if (result.rows.length === 0) throw new Error(`Failed to fetch article ${article_id}: not found`);
					return result.rows[0] as Article;
				} finally {
					await db.end();
				}
			},
		)) as Article;

		if (!article) {
			logWarn('WORKFLOW', 'Article not found', { article_id });
			return { success: false, article_id, reason: 'not_found' };
		}

		if (isUserFile && !article.content && isUploadedPdf(article)) {
			const storageKey = article.storage_key as string;
			const extracted = (await step.do(
				'extract-pdf-text',
				{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
				() => extractAndPersistPdf(this.env, article_id, storageKey),
			)) as string;
			article.content = extracted;
		}

		// Step 2: AI analysis (translate / tags / summary)
		const processorResult = (await step.do(
			'ai-analysis',
			{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '180 seconds' },
			async () => {
				const db = await createDbClient(this.env);
				try {
					return await runArticleProcessor(article, source_type, {
						env: this.env,
						db,
						table,
					});
				} finally {
					await db.end();
				}
			},
		)) as ProcessorResult;

		// Step 3: Fetch OG image if missing (lightweight — only downloads first 32KB of HTML)
		if (!article.og_image_url && !processorResult.updateData.og_image_url) {
			const ogResult = await step.do('fetch-og-image', { retries: { limit: 1, delay: '3 seconds' }, timeout: '10 seconds' }, async () =>
				fetchOgImage(article.url),
			);
			if (ogResult?.ogImageUrl) {
				processorResult.updateData.og_image_url = ogResult.ogImageUrl;
			}
		}

		// Step 4: Translate content to Chinese (no DB write, just returns the translation)
		const contentToTranslate = processorResult.updateData.content ?? article.content;
		const needsTranslation = contentToTranslate && contentToTranslate.length > 100 && !processorResult.updateData.content_cn;
		const contentCn = needsTranslation
			? ((await step.do(
					'translate-content',
					{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '180 seconds' },
					async () => {
						const translated = await translateContent(contentToTranslate, this.env.OPENROUTER_API_KEY);
						if (translated) logInfo('WORKFLOW', 'Content translated', { article_id, chars: translated.length });
						return translated;
					},
				)) as string | null)
			: null;

		// Step 5: Write all AI results to DB in a single UPDATE
		if (contentCn) processorResult.updateData.content_cn = contentCn;

		await step.do('update-db', { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' }, async () => {
			const db = await createDbClient(this.env);
			try {
				await persistProcessorResult(article_id, article, processorResult, {
					env: this.env,
					db,
					table,
				});
				const fields = Object.keys(processorResult.updateData);
				if (fields.length > 0) logInfo('WORKFLOW', 'Updated fields', { fields: fields.join(', ') });
				if (processorResult.enrichments && Object.keys(processorResult.enrichments).length > 0) {
					logInfo('WORKFLOW', 'Enrichments saved', { enrichments: Object.keys(processorResult.enrichments).join(', ') });
				}
			} finally {
				await db.end();
			}
		});

		// Step 5b: Sync entities to normalized tables (article_entities FKs point at
		// public `articles` only — user_files rows skip this step).
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

		// Step 6: Generate YouTube highlights (if applicable)
		if (source_type === 'youtube' && article.platform_metadata?.type === 'youtube') {
			await step.do(
				'generate-youtube-highlights',
				{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
				() => generateAndSaveYouTubeHighlights(this.env, article_id, article),
			);
		}

		// Step 8: Generate and save embedding
		const _hasEmbedding = (await step.do(
			'generate-and-save-embedding',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
			async () => {
				const text = buildEmbeddingTextForArticle(article, processorResult);
				if (!text || !this.env.AI) return false;
				const embedding = await generateArticleEmbedding(text, this.env.AI);
				if (!embedding) return false;
				const db = await createDbClient(this.env);
				try {
					const saved = await saveArticleEmbedding(db, article_id, embedding, table);
					if (!saved) throw new Error(`Failed to save embedding for ${article_id}`);
					logInfo('WORKFLOW', 'Embedding saved', { article_id });
					return true;
				} finally {
					await db.end();
				}
			},
		)) as boolean;

		logInfo('WORKFLOW', 'Completed', { article_id });
		return { success: true, article_id };
	}
}
