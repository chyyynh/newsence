import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { ARTICLES_TABLE, createDbClient } from '../infra/db';
import { generateArticleEmbedding, saveArticleEmbedding } from '../infra/embedding';
import { logError, logInfo, logWarn } from '../infra/log';
import type { Article, BotNotifyArticle, Env, MessageBatch, QueueMessage, TelegramNotifyContext } from '../models/types';
import { syncArticleEntities } from './entities';
import {
	buildEmbeddingTextForArticle,
	generateYouTubeHighlights,
	type ProcessorResult,
	persistProcessorResult,
	runArticleProcessor,
	translateContent,
} from './processors';
import { fetchOgImage } from './scrapers';

const ARTICLE_FIELDS =
	'id, title, title_cn, summary, summary_cn, content, url, source, source_type, published_date, tags, keywords, scraped_date, og_image_url, platform_metadata, entities';

type WorkflowParams = {
	article_id: string;
	source_type: string;
	notify_context?: TelegramNotifyContext;
	target_table?: string;
};

const SOURCE_TYPE_BATCH_SIZE = 200;
const SOURCE_TYPE_FALLBACK = 'default';

async function fetchSourceTypeMap(articleIds: string[], env: Env): Promise<Map<string, string>> {
	if (articleIds.length === 0) return new Map();

	const table = ARTICLES_TABLE;
	const sourceTypes = new Map<string, string>();
	const db = await createDbClient(env);

	try {
		for (let i = 0; i < articleIds.length; i += SOURCE_TYPE_BATCH_SIZE) {
			const batchIds = articleIds.slice(i, i + SOURCE_TYPE_BATCH_SIZE);
			try {
				const result = await db.query(`SELECT id, source_type FROM ${table} WHERE id = ANY($1)`, [batchIds]);
				for (const row of result.rows) {
					if (row.id && row.source_type) sourceTypes.set(row.id, row.source_type);
				}
			} catch (error) {
				logWarn('ARTICLE-QUEUE', 'Failed to fetch source types', { error: String(error) });
			}
		}
	} finally {
		await db.end();
	}

	return sourceTypes;
}

export async function handleArticleQueue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
	logInfo('ARTICLE-QUEUE', 'Received batch', { count: batch.messages.length });

	for (const message of batch.messages) {
		const body = message.body;

		try {
			if (body.type === 'article_process') {
				await env.MONITOR_WORKFLOW.create({
					params: {
						article_id: body.article_id,
						source_type: body.source_type,
						...(body.target_table ? { target_table: body.target_table } : {}),
					},
				});
				logInfo('ARTICLE-QUEUE', 'Created workflow for article', { article_id: body.article_id });
				message.ack();
			} else if (body.type === 'batch_process') {
				const sourceTypeMap = await fetchSourceTypeMap(body.article_ids, env);
				for (const id of body.article_ids) {
					const sourceType = sourceTypeMap.get(id) ?? SOURCE_TYPE_FALLBACK;
					await env.MONITOR_WORKFLOW.create({
						params: {
							article_id: id,
							source_type: sourceType,
							...(body.target_table ? { target_table: body.target_table } : {}),
						},
					});
				}
				logInfo('ARTICLE-QUEUE', 'Created workflows (batch)', { count: body.article_ids.length, triggered_by: body.triggered_by });
				message.ack();
			} else {
				logWarn('ARTICLE-QUEUE', 'Unknown message type, acking');
				message.ack();
			}
		} catch (err) {
			logError('ARTICLE-QUEUE', 'Error handling message, retrying', { error: String(err) });
			message.retry();
		}
	}
}

export class NewsenceMonitorWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
	async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
		const { article_id, source_type, notify_context, target_table } = event.payload;
		const table = target_table ?? ARTICLES_TABLE;
		const isUserArticle = table !== ARTICLES_TABLE;

		logInfo('WORKFLOW', 'Starting', { article_id, source_type });

		// Step 1: Fetch article from DB
		const article = (await step.do(
			'fetch-article',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => {
				const db = await createDbClient(this.env);
				try {
					const result = await db.query(`SELECT ${ARTICLE_FIELDS} FROM ${table} WHERE id = $1`, [article_id]);
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

		// Step 5b: Sync entities to normalized tables
		if (processorResult.updateData.entities?.length) {
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

		// Step 6: Notify Telegram bot with AI results (push-based, via RPC)
		if (notify_context && this.env.TELEGRAM_BOT) {
			await step.do(
				'notify-telegram',
				{ retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '15 seconds' },
				async () => {
					const db = await createDbClient(this.env);
					try {
						const result = await db.query(`SELECT ${ARTICLE_FIELDS} FROM ${table} WHERE id = $1`, [article_id]);
						const updatedArticle = result.rows[0] as BotNotifyArticle | undefined;
						if (!updatedArticle) return;

						try {
							await this.env.TELEGRAM_BOT.notify(updatedArticle, notify_context);
							logInfo('WORKFLOW', 'Telegram notified', { article_id });
						} catch (err) {
							logWarn('WORKFLOW', 'Telegram notify failed', { error: String(err) });
						}
					} finally {
						await db.end();
					}
				},
			);
		}

		// Step 7: Generate YouTube highlights (if applicable)
		if (source_type === 'youtube' && article.platform_metadata?.type === 'youtube') {
			await step.do(
				'generate-youtube-highlights',
				{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
				async () => {
					const videoId = article.platform_metadata?.type === 'youtube' ? article.platform_metadata.data.videoId : null;
					if (!videoId) return;

					const db = await createDbClient(this.env);
					try {
						const result = await db.query<{
							transcript: Array<{ startTime: number; endTime: number; text: string }> | null;
							ai_highlights: unknown;
						}>('SELECT transcript, ai_highlights FROM youtube_transcripts WHERE video_id = $1', [videoId]);
						const row = result.rows[0];
						if (!row || row.ai_highlights || !Array.isArray(row.transcript) || row.transcript.length === 0) return;

						const highlights = await generateYouTubeHighlights(videoId, row.transcript, this.env.OPENROUTER_API_KEY);
						if (!highlights) return;

						const aiHighlights = {
							version: '1.0',
							model: 'google/gemini-3-flash-preview',
							highlights: highlights.highlights,
							generatedAt: new Date().toISOString(),
						};
						await db.query('UPDATE youtube_transcripts SET ai_highlights = $1, highlights_generated_at = $2 WHERE video_id = $3', [
							JSON.stringify(aiHighlights),
							new Date().toISOString(),
							videoId,
						]);
						logInfo('WORKFLOW', 'YouTube highlights saved', { videoId, count: highlights.highlights.length });
					} finally {
						await db.end();
					}
				},
			);
		}

		// Step 8: Generate and save embedding
		const hasEmbedding = (await step.do(
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
