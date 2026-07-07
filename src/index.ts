import { WorkerEntrypoint, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type {
	ArticleRankSearchInput,
	ArticleSearchInput,
	CoreRpc,
	CoreUploadedFileInput,
	ReadContextItem,
	RelatedArticleSearchInput,
	ScrapedUrlContent,
	StoreGeneratedImageInput,
} from '@core-rpc/contracts';
import { routeRequest } from '@entry/http';
import { ingestUploadedFile, persistGeneratedImage } from '@ingest/blob';
import { type ExtractInput, extractSource, type NormalizedContent, SCRAPE_INPUT_TEMP_PREFIX } from '@ingest/extract';
import { handleRSSCron } from '@ingest/platforms/rss/monitor';
import { handleTwitterCron } from '@ingest/platforms/twitter/monitor';
import { handleYouTubeCron } from '@ingest/platforms/youtube/monitor';
import { NewsenceMonitorWorkflow } from '@ingest/workflows/article-processing.workflow';
import { createWorkflowsForQueueMessages, handleRetryCron, type QueueMessage } from '@ingest/workflows/queue';
import { readCorpusItems, relatedCorpusArticleIds, searchCorpusArticleRanks, searchCorpusArticles } from './corpus';
import { ingestUrls } from './ingest/urls';

export { NewsenceMonitorWorkflow };

// Bytes can't fit Workflow params, so the job path only ever passes a URL or a
// staged R2 key — never inline bytes.
type ScrapeWorkflowParams = Extract<ExtractInput, { kind: 'url' } | { kind: 'r2' }>;

// Non-persisting scrape job. Unlike NewsenceMonitorWorkflow this creates no DB
// row — the result is returned as the Workflow `output`, polled via
// GET /scrape/jobs/:id.
export class ScrapeWorkflow extends WorkflowEntrypoint<Env, ScrapeWorkflowParams> {
	async run(event: WorkflowEvent<ScrapeWorkflowParams>, step: WorkflowStep): Promise<NormalizedContent> {
		const input = event.payload;

		const result = await step.do(
			'extract',
			{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
			() => extractSource(this.env, input),
		);

		if (input.kind === 'r2' && input.key.startsWith(SCRAPE_INPUT_TEMP_PREFIX)) {
			await step.do('cleanup', { retries: { limit: 2, delay: '5 seconds' }, timeout: '15 seconds' }, () => this.env.R2.delete(input.key));
		}

		console.info({ tag: 'SCRAPE_WORKFLOW', msg: 'Completed', kind: input.kind, status: result.status, chars: result.metadata.chars });
		return result;
	}
}

export default class CoreWorker extends WorkerEntrypoint<Env> implements CoreRpc {
	override async fetch(request: Request): Promise<Response> {
		return routeRequest(request, this.env, this.ctx);
	}

	override scheduled(event: ScheduledController): void {
		console.info({ tag: 'CORE', msg: 'Scheduled', cron: event.cron });

		if (event.cron === '*/5 * * * *') this.ctx.waitUntil(handleRSSCron(this.env));
		else if (event.cron === '0 */6 * * *') this.ctx.waitUntil(handleTwitterCron(this.env));
		else if (event.cron === '*/30 * * * *') this.ctx.waitUntil(handleYouTubeCron(this.env));
		else if (event.cron === '0 3 * * *') this.ctx.waitUntil(handleRetryCron(this.env));
	}

	override async queue(batch: MessageBatch<QueueMessage>): Promise<void> {
		console.info({ tag: 'CORE', msg: 'Queue received', queue: batch.queue, count: batch.messages.length });

		try {
			const result = await createWorkflowsForQueueMessages(this.env, batch.messages);
			console.info({ tag: 'ARTICLE-QUEUE', msg: 'Created workflows', ...result });
			batch.ackAll();
		} catch (err) {
			console.error({ tag: 'ARTICLE-QUEUE', msg: 'Error handling batch, retrying', error: String(err) });
			batch.retryAll();
		}
	}

	// ── Service-binding RPC for engine capabilities ─────────────────────────
	// Product-domain writes live on the app Worker's DomainRpc binding.

	/** Persist a generated image into the canonical user_file blob store. */
	storeGeneratedImage(input: StoreGeneratedImageInput) {
		return persistGeneratedImage(this.env, input);
	}

	/** Ingest user-submitted URLs into user_files without going through public HTTP auth. */
	ingestUrls(input: { urls: string[]; userId?: string }) {
		return ingestUrls(this.env, input);
	}

	/** Ingest an uploaded PDF/image without encoding it as multipart HTTP between Workers. */
	ingestUploadedFile(input: CoreUploadedFileInput) {
		return ingestUploadedFile(this.env, input);
	}

	/** Hybrid article search (embeddings + keywords) for the chat search-news tool. */
	searchArticles(input: ArticleSearchInput) {
		return searchCorpusArticles(this.env, input);
	}

	/** Hybrid rank search for app-side feed/context lookup. */
	searchArticleRanks(input: ArticleRankSearchInput) {
		return searchCorpusArticleRanks(this.env, input);
	}

	/** Related article ids for app-side recommendations. */
	relatedArticleIds(input: RelatedArticleSearchInput) {
		return relatedCorpusArticleIds(this.env, input);
	}

	/** Extract one URL without creating user_files/articles. Intended for future chat agent reads. */
	scrapeUrl(url: string): Promise<ScrapedUrlContent> {
		return extractSource(this.env, { kind: 'url', url });
	}

	/** Read article/collection/url resources from the core corpus. */
	readCorpusItems(items: ReadContextItem[], userId: string) {
		return readCorpusItems(this.env, items, userId);
	}
}
