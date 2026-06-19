import { WorkerEntrypoint } from 'cloudflare:workers';
import { handleArticleQueue, handleScheduled } from '@entry/events';
import { routeRequest } from '@entry/http';
import { type ArticleSummary, type CorpusReadItem, type CorpusReadResult, ingestUrls, readItems, searchArticles } from '@entry/rpc';
import { NewsenceMonitorWorkflow } from '@ingest/workflows/article-processing.workflow';
import { ScrapeWorkflow } from '@ingest/workflows/scrape.workflow';
import type { Env, MessageBatch, QueueMessage, ScheduledEvent } from '@shared/types';

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
		return ingestUrls(this.env, urls, userId);
	}

	/** Hybrid article search (embeddings + keywords) for the chat search-news tool. */
	searchArticles(query: string, opts?: { daysAgo?: number; limit?: number }): Promise<ArticleSummary[]> {
		return searchArticles(this.env, query, opts);
	}

	/** Read article/collection/url resources from the core corpus (documents are read via Vercel). */
	readCorpusItems(items: CorpusReadItem[], userId: string): Promise<CorpusReadResult[]> {
		return readItems(this.env, items, userId);
	}
}
