import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { Env, Article } from './types';
import { getSupabaseClient, getArticlesTable } from './utils/supabase';
import { getProcessor, ProcessorContext, ProcessorResult } from './processors';
import { prepareArticleTextForEmbedding, generateArticleEmbedding, saveArticleEmbedding } from './utils/embedding';

const ARTICLE_FIELDS = 'id, title, title_cn, summary, summary_cn, content, url, source, source_type, published_date, tags, keywords, scraped_date, og_image_url, platform_metadata';

type WorkflowParams = {
	article_id: string;
	source_type: string;
};

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
			{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
			async () => {
				const processor = getProcessor(source_type);
				const supabase = getSupabaseClient(this.env);
				const ctx: ProcessorContext = { env: this.env, supabase, table };
				return await processor.process(article, ctx);
			}
		) as ProcessorResult;

		// Step 3: Update DB with AI results
		await step.do(
			'update-db',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => {
				const supabase = getSupabaseClient(this.env);

				// Update article fields
				if (Object.keys(processorResult.updateData).length > 0) {
					const { error } = await supabase.from(table).update(processorResult.updateData).eq('id', article_id);
					if (error) throw new Error(`Failed to update article ${article_id}: ${error.message}`);
					console.log(`[WORKFLOW] Updated fields: ${Object.keys(processorResult.updateData).join(', ')}`);
				}

				// Update enrichments
				if (processorResult.enrichments && Object.keys(processorResult.enrichments).length > 0) {
					const existingMetadata = article.platform_metadata || {};
					const updatedMetadata = {
						...existingMetadata,
						enrichments: {
							...(existingMetadata.enrichments || {}),
							...processorResult.enrichments,
							processedAt: new Date().toISOString(),
						},
					};
					const { error } = await supabase.from(table).update({ platform_metadata: updatedMetadata }).eq('id', article_id);
					if (error) throw new Error(`Failed to update enrichments for ${article_id}: ${error.message}`);
					console.log(`[WORKFLOW] Enrichments saved: ${Object.keys(processorResult.enrichments).join(', ')}`);
				}
			}
		);

		// Step 4: Generate embedding
		const embedding = await step.do(
			'generate-embedding',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => {
				const text = prepareArticleTextForEmbedding({
					title: article.title,
					title_cn: processorResult.updateData.title_cn ?? article.title_cn,
					summary: processorResult.updateData.summary ?? article.summary,
					summary_cn: processorResult.updateData.summary_cn ?? article.summary_cn,
					tags: processorResult.updateData.tags ?? article.tags,
					keywords: processorResult.updateData.keywords ?? article.keywords,
				});
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
