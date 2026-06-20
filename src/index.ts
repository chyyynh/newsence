import { WorkerEntrypoint } from 'cloudflare:workers';
import { routeRequest } from '@entry/http';
import { handleRSSCron } from '@ingest/platforms/rss/monitor';
import { handleTwitterCron } from '@ingest/platforms/twitter/monitor';
import { handleYouTubeCron } from '@ingest/platforms/youtube/monitor';
import { handleRetryCron } from '@ingest/retry';
import { ingestUrls as ingestUrlsForUser } from '@ingest/urls';
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

	// ── Service-binding RPC for the chat worker (split Phase 4) ──────────────
	// Thin delegates to the domain facades — the same in-process calls the chat
	// tools made before chat moved to its own worker. The chat worker binds this
	// worker as `CORE` and calls these as `env.CORE.ingestUrls(...)`.

	/** Crawl + save external URLs to a user's library; returns created user_file IDs. */
	async ingestUrls(urls: string[], userId: string): Promise<string[]> {
		if (urls.length === 0) return [];
		try {
			const outcome = await ingestUrlsForUser(this.env, { urls, userId });
			return outcome.ok ? outcome.results.map((r) => r.userFileId).filter((id): id is string => !!id) : [];
		} catch (err) {
			console.error({ tag: 'CORE', msg: 'ingestUrls failed', error: String(err) });
			return [];
		}
	}

	/** Hybrid article search (embeddings + keywords) for the chat search-news tool. */
	searchArticles(query: string, opts?: { daysAgo?: number; limit?: number }): Promise<ArticleSummary[]> {
		return searchCorpusArticles(this.env, query, opts);
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
