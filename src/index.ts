import { WorkerEntrypoint } from 'cloudflare:workers';
import { routeRequest } from '@entry/http';
import { type PersistGeneratedImageResult, persistGeneratedImage } from '@ingest/blob-persistence';
import { extractSource, type NormalizedContent } from '@ingest/extract';
import { handleRSSCron } from '@ingest/platforms/rss/monitor';
import { handleTwitterCron } from '@ingest/platforms/twitter/monitor';
import { handleYouTubeCron } from '@ingest/platforms/youtube/monitor';
import { handleRetryCron } from '@ingest/retry';
import { NewsenceMonitorWorkflow } from '@ingest/workflows/article-processing.workflow';
import { ScrapeWorkflow } from '@ingest/workflows/scrape.workflow';
import type { Env, ExecutionContext, MessageBatch, ScheduledEvent } from '@shared/types';
import { ensureWorkflowsForQueueMessage, type QueueMessage } from '@shared/workflow-queue';
import type { ArticleSummary, CorpusReadItem, CorpusReadResult } from './corpus';
import { readCorpusItems, searchCorpusArticles } from './corpus';

export { NewsenceMonitorWorkflow, ScrapeWorkflow };

export default class CoreWorker extends WorkerEntrypoint<Env> {
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

	// ── Service-binding RPC for the chat worker ──────────────────────────────
	// Thin delegates to core-owned domain facades. URL add-resource ingestion is
	// intentionally handled by the frontend document endpoint because citation
	// writes and workspace ownership live there.

	/** Persist a generated image into the canonical user_file blob store. */
	storeGeneratedImage(input: {
		userId: string;
		bytes: Uint8Array;
		contentType: string;
		title: string;
	}): Promise<PersistGeneratedImageResult> {
		return persistGeneratedImage(this.env, input);
	}

	/** Hybrid article search (embeddings + keywords) for the chat search-news tool. */
	searchArticles(query: string, opts?: { daysAgo?: number; limit?: number }): Promise<ArticleSummary[]> {
		return searchCorpusArticles(this.env, query, opts);
	}

	/** Extract one URL without creating user_files/articles. Intended for future chat agent reads. */
	scrapeUrl(url: string): Promise<NormalizedContent> {
		return extractSource(this.env, { kind: 'url', url });
	}

	/** Read article/collection/url resources from the core corpus (documents are read via Vercel). */
	readCorpusItems(items: CorpusReadItem[], userId: string): Promise<CorpusReadResult[]> {
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

	for (const message of batch.messages) {
		try {
			const { count, created, existing, skipped } = await ensureWorkflowsForQueueMessage(env, message.id, message.body);
			console.info({ tag: 'ARTICLE-QUEUE', msg: 'Ensured workflows', count, created, existing, skipped });
			message.ack();
		} catch (err) {
			console.error({ tag: 'ARTICLE-QUEUE', msg: 'Error handling message, retrying', error: String(err) });
			message.retry();
		}
	}
}
