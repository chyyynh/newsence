import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { generateYouTubeHighlights } from '../infra/ai';
import { getArticlesTable, getSupabaseClient } from '../infra/db';
import { generateArticleEmbedding, saveArticleEmbedding } from '../infra/embedding';
import { logError, logInfo, logWarn } from '../infra/log';
import type { Article, Env, MessageBatch, QueueMessage } from '../models/types';
import {
	buildEmbeddingTextForArticle,
	type ProcessorResult,
	persistProcessorResult,
	runArticleProcessor,
	translateContent,
} from './processors';
import { assignArticleTopic, synthesizeTopicSummary, type TopicAssignmentResult } from './topics';

const ARTICLE_FIELDS =
	'id, title, title_cn, summary, summary_cn, content, url, source, source_type, published_date, tags, keywords, scraped_date, og_image_url, platform_metadata';

type WorkflowParams = {
	article_id: string;
	source_type: string;
};

const SOURCE_TYPE_BATCH_SIZE = 200;
const SOURCE_TYPE_FALLBACK = 'default';

async function fetchSourceTypeMap(articleIds: string[], env: Env): Promise<Map<string, string>> {
	if (articleIds.length === 0) return new Map();

	const supabase = getSupabaseClient(env);
	const table = getArticlesTable(env);
	const sourceTypes = new Map<string, string>();

	for (let i = 0; i < articleIds.length; i += SOURCE_TYPE_BATCH_SIZE) {
		const batchIds = articleIds.slice(i, i + SOURCE_TYPE_BATCH_SIZE);
		const { data, error } = await supabase.from(table).select('id, source_type').in('id', batchIds);
		if (error) {
			logWarn('ARTICLE-QUEUE', 'Failed to fetch source types', { error: String(error) });
			continue;
		}
		for (const row of data ?? []) {
			if (row.id && row.source_type) sourceTypes.set(row.id, row.source_type);
		}
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
					params: { article_id: body.article_id, source_type: body.source_type },
				});
				logInfo('ARTICLE-QUEUE', 'Created workflow for article', { article_id: body.article_id });
				message.ack();
			} else if (body.type === 'batch_process') {
				const sourceTypeMap = await fetchSourceTypeMap(body.article_ids, env);
				for (const id of body.article_ids) {
					const sourceType = sourceTypeMap.get(id) ?? SOURCE_TYPE_FALLBACK;
					await env.MONITOR_WORKFLOW.create({
						params: { article_id: id, source_type: sourceType },
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
		const { article_id, source_type } = event.payload;
		const table = getArticlesTable(this.env);

		logInfo('WORKFLOW', 'Starting', { article_id, source_type });

		// Step 1: Fetch article from DB
		const article = (await step.do(
			'fetch-article',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => {
				const supabase = getSupabaseClient(this.env);
				const { data, error } = await supabase.from(table).select(ARTICLE_FIELDS).eq('id', article_id).single();
				if (error) throw new Error(`Failed to fetch article ${article_id}: ${error.message}`);
				return data as Article;
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
				const supabase = getSupabaseClient(this.env);
				return await runArticleProcessor(article, source_type, {
					env: this.env,
					supabase,
					table,
				});
			},
		)) as ProcessorResult;

		// Step 3: Translate content to Chinese (no DB write, just returns the translation)
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

		// Step 4: Write all AI results to DB in a single UPDATE
		if (contentCn) processorResult.updateData.content_cn = contentCn;

		await step.do('update-db', { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' }, async () => {
			const supabase = getSupabaseClient(this.env);
			await persistProcessorResult(article_id, article, processorResult, {
				env: this.env,
				supabase,
				table,
			});
			const fields = Object.keys(processorResult.updateData);
			if (fields.length > 0) logInfo('WORKFLOW', 'Updated fields', { fields: fields.join(', ') });
			if (processorResult.enrichments && Object.keys(processorResult.enrichments).length > 0) {
				logInfo('WORKFLOW', 'Enrichments saved', { enrichments: Object.keys(processorResult.enrichments).join(', ') });
			}
		});

		// Step 5: Generate YouTube highlights (if applicable)
		if (source_type === 'youtube' && article.platform_metadata?.type === 'youtube') {
			await step.do(
				'generate-youtube-highlights',
				{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
				async () => {
					const videoId = article.platform_metadata?.type === 'youtube' ? article.platform_metadata.data.videoId : null;
					if (!videoId) return;

					const supabase = getSupabaseClient(this.env);
					const { data: row } = await supabase
						.from('youtube_transcripts')
						.select('transcript, ai_highlights')
						.eq('video_id', videoId)
						.single();

					if (!row) return;
					if (row.ai_highlights) {
						logInfo('WORKFLOW', 'YouTube highlights already exist, skipping', { videoId });
						return;
					}
					if (!Array.isArray(row.transcript) || row.transcript.length === 0) return;

					await generateYouTubeHighlights(videoId, row.transcript as any, this.env);
				},
			);
		}

		// Step 6: Generate embedding
		const embedding = (await step.do(
			'generate-embedding',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => {
				const text = buildEmbeddingTextForArticle(article, processorResult);
				if (!text || !this.env.AI) return null;
				return await generateArticleEmbedding(text, this.env.AI);
			},
		)) as number[] | null;

		// Step 7: Save embedding
		if (embedding) {
			await step.do(
				'save-embedding',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				async () => {
					const supabase = getSupabaseClient(this.env);
					const saved = await saveArticleEmbedding(supabase, article_id, embedding, table);
					if (!saved) throw new Error(`Failed to save embedding for ${article_id}`);
					logInfo('WORKFLOW', 'Embedding saved', { article_id });
				},
			);

			// Step 8: Assign topic (cluster similar articles)
			const topicResult = (await step.do(
				'assign-topic',
				{ retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				async () => {
					const supabase = getSupabaseClient(this.env);
					return await assignArticleTopic(supabase, article_id, table);
				},
			)) as TopicAssignmentResult;

			// Step 9: Synthesize topic summary if needed
			if (topicResult.needsSynthesis && topicResult.topicId && this.env.OPENROUTER_API_KEY) {
				await step.do(
					'synthesize-topic',
					{ retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
					async () => {
						const supabase = getSupabaseClient(this.env);
						await synthesizeTopicSummary(supabase, topicResult.topicId!, table, this.env.OPENROUTER_API_KEY);
					},
				);
			}
		}

		logInfo('WORKFLOW', 'Completed', { article_id });
		return { success: true, article_id };
	}
}
