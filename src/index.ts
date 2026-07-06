import { WorkerEntrypoint } from 'cloudflare:workers';
import type { ArticleSearchInput, CoreRpc, ReadContextItem, ScrapedUrlContent, StoreGeneratedImageInput } from '@core-rpc/contracts';
import type { Env } from '@core-shared/types';
import {
	ensureWorkflowsForQueueMessages,
	type ParsedQueueMessage,
	parseWorkflowQueueMessage,
	type QueueMessage,
} from '@core-shared/workflow-queue';
import { routeRequest } from '@entry/http';
import { persistGeneratedImage } from '@ingest/blob-persistence';
import { extractSource } from '@ingest/extract';
import { handleRSSCron } from '@ingest/platforms/rss/monitor';
import { handleTwitterCron } from '@ingest/platforms/twitter/monitor';
import { handleYouTubeCron } from '@ingest/platforms/youtube/monitor';
import { handleRetryCron } from '@ingest/retry';
import { NewsenceMonitorWorkflow } from '@ingest/workflows/article-processing.workflow';
import { ScrapeWorkflow } from '@ingest/workflows/scrape.workflow';
import { readCorpusItems, searchCorpusArticles } from './corpus';

export { NewsenceMonitorWorkflow, ScrapeWorkflow };

export default class CoreWorker extends WorkerEntrypoint<Env> implements CoreRpc {
	override async fetch(request: Request): Promise<Response> {
		return routeRequest(request, this.env, this.ctx);
	}

	scheduled(event: ScheduledEvent): void {
		handleScheduled(event, this.env, this.ctx);
	}

	async queue(batch: MessageBatch<QueueMessage>): Promise<void> {
		console.info({ tag: 'CORE', msg: 'Queue received', queue: batch.queue, count: batch.messages.length });
		await handleArticleQueue(batch, this.env);
	}

	// ── Service-binding RPC for engine capabilities ─────────────────────────
	// Product-domain writes live on the app Worker's DomainRpc binding.

	/** Persist a generated image into the canonical user_file blob store. */
	storeGeneratedImage(input: StoreGeneratedImageInput) {
		return persistGeneratedImage(this.env, input);
	}

	/** Hybrid article search (embeddings + keywords) for the chat search-news tool. */
	searchArticles(input: ArticleSearchInput) {
		return searchCorpusArticles(this.env, input);
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

function handleScheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): void {
	console.info({ tag: 'CORE', msg: 'Scheduled', cron: event.cron });

	if (event.cron === '*/5 * * * *') ctx.waitUntil(handleRSSCron(env, ctx));
	else if (event.cron === '0 */6 * * *') ctx.waitUntil(handleTwitterCron(env, ctx));
	else if (event.cron === '*/30 * * * *') ctx.waitUntil(handleYouTubeCron(env, ctx));
	else if (event.cron === '0 3 * * *') ctx.waitUntil(handleRetryCron(env, ctx));
}

async function handleArticleQueue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
	console.info({ tag: 'ARTICLE-QUEUE', msg: 'Received batch', count: batch.messages.length });

	const messages: ParsedQueueMessage[] = [];
	let skipped = 0;
	for (const message of batch.messages) {
		const parsed = parseWorkflowQueueMessage(message.id, message.body);
		if (parsed) {
			messages.push(parsed);
		} else {
			skipped++;
			console.warn({ tag: 'ARTICLE-QUEUE', msg: 'Skipping invalid queue message', messageId: message.id });
			message.ack();
		}
	}

	try {
		const result = await ensureWorkflowsForQueueMessages(env, messages);
		console.info({ tag: 'ARTICLE-QUEUE', msg: 'Ensured workflows', ...result, skipped });
		batch.ackAll();
	} catch (err) {
		console.error({ tag: 'ARTICLE-QUEUE', msg: 'Error handling batch, retrying', error: String(err) });
		batch.retryAll();
	}
}
