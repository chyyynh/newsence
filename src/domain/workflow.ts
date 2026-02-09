import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { Env, Article, MessageBatch, QueueMessage } from '../models/types';
import { getSupabaseClient, getArticlesTable } from '../infra/db';
import {
	ProcessorResult,
	runArticleProcessor,
	persistProcessorResult,
	buildEmbeddingTextForArticle,
} from './processors';
import { generateArticleEmbedding, saveArticleEmbedding } from '../infra/embedding';

const ARTICLE_FIELDS = 'id, title, title_cn, summary, summary_cn, content, url, source, source_type, published_date, tags, keywords, scraped_date, og_image_url, platform_metadata';

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
			console.warn('[ARTICLE-QUEUE] Failed to fetch source types:', error);
			continue;
		}
		for (const row of data ?? []) {
			if (row.id && row.source_type) sourceTypes.set(row.id, row.source_type);
		}
	}

	return sourceTypes;
}

export async function handleArticleQueue(
	batch: MessageBatch<QueueMessage>,
	env: Env
): Promise<void> {
	console.log(`[ARTICLE-QUEUE] Received batch of ${batch.messages.length} messages`);

	for (const message of batch.messages) {
		const body = message.body;

		try {
			if (body.type === 'article_process') {
				await env.MONITOR_WORKFLOW.create({
					params: { article_id: body.article_id, source_type: body.source_type },
				});
				console.log(`[ARTICLE-QUEUE] Created workflow for article ${body.article_id}`);
				message.ack();
			} else if (body.type === 'batch_process') {
				const sourceTypeMap = await fetchSourceTypeMap(body.article_ids, env);
				for (const id of body.article_ids) {
					const sourceType = sourceTypeMap.get(id) ?? SOURCE_TYPE_FALLBACK;
					await env.MONITOR_WORKFLOW.create({
						params: { article_id: id, source_type: sourceType },
					});
				}
				console.log(`[ARTICLE-QUEUE] Created ${body.article_ids.length} workflows (batch from ${body.triggered_by})`);
				message.ack();
			} else {
				console.warn('[ARTICLE-QUEUE] Unknown message type, acking');
				message.ack();
			}
		} catch (err) {
			console.error('[ARTICLE-QUEUE] Error handling message, retrying:', err);
			message.retry();
		}
	}
}

export class NewsenceMonitorWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
	async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
		const { article_id, source_type } = event.payload;
		const table = getArticlesTable(this.env);

		console.log(`[WORKFLOW] Starting for article ${article_id} (${source_type})`);

		// Step 1: Fetch article from DB
		const article = await step.do(
			'fetch-article',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => {
				const supabase = getSupabaseClient(this.env);
				const { data, error } = await supabase.from(table).select(ARTICLE_FIELDS).eq('id', article_id).single();
				if (error) throw new Error(`Failed to fetch article ${article_id}: ${error.message}`);
				return data as Article;
			}
		) as Article;

		if (!article) {
			console.log(`[WORKFLOW] Article ${article_id} not found`);
			return { success: false, article_id, reason: 'not_found' };
		}

		// Step 2: AI analysis (translate / tags / summary)
		const processorResult = await step.do(
			'ai-analysis',
			{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '180 seconds' },
			async () => {
				const supabase = getSupabaseClient(this.env);
				return await runArticleProcessor(article, source_type, {
					env: this.env,
					supabase,
					table,
				});
			}
		) as ProcessorResult;

		// Step 3: Update DB with AI results
		await step.do(
			'update-db',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => {
				const supabase = getSupabaseClient(this.env);
				await persistProcessorResult(article_id, article, processorResult, {
					env: this.env,
					supabase,
					table,
				});
				if (Object.keys(processorResult.updateData).length > 0) {
					console.log(`[WORKFLOW] Updated fields: ${Object.keys(processorResult.updateData).join(', ')}`);
				}
				if (processorResult.enrichments && Object.keys(processorResult.enrichments).length > 0) {
					console.log(`[WORKFLOW] Enrichments saved: ${Object.keys(processorResult.enrichments).join(', ')}`);
				}
			}
		);

		// Step 4: Generate embedding
		const embedding = await step.do(
			'generate-embedding',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => {
				const text = buildEmbeddingTextForArticle(article, processorResult);
				if (!text || !this.env.AI) return null;
				return await generateArticleEmbedding(text, this.env.AI);
			}
		) as number[] | null;

		// Step 5: Save embedding
		if (embedding) {
			await step.do(
				'save-embedding',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				async () => {
					const supabase = getSupabaseClient(this.env);
					const saved = await saveArticleEmbedding(supabase, article_id, embedding, table);
					if (!saved) throw new Error(`Failed to save embedding for ${article_id}`);
					console.log(`[WORKFLOW] Embedding saved for ${article_id}`);
				}
			);
		}

		console.log(`[WORKFLOW] Completed for article ${article_id}`);
		return { success: true, article_id };
	}
}
