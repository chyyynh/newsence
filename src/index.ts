import { WorkerEntrypoint } from 'cloudflare:workers';
import { routeRequest } from '@entry/http';
import { handleQueue } from '@entry/queue';
import { handleScheduled } from '@entry/scheduled';
import { ingestUrlsForUser } from '@ingest/service';
import { NewsenceMonitorWorkflow } from '@ingest/workflows/article-processing.workflow';
import { ScrapeWorkflow } from '@ingest/workflows/scrape.workflow';
import { generateImage as mediaGenerateImage } from '@media/service';
import {
	type ArticleSummary,
	type ReadContextItem,
	type ReadContextResult,
	readContextItems as retrievalReadContextItems,
	searchArticles as retrievalSearchArticles,
} from '@retrieval/service';
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
		await handleQueue(batch, this.env);
	}

	// ── Service-binding RPC for the chat worker (split Phase 4) ──────────────
	// Thin delegates to the domain facades — the same in-process calls the chat
	// tools made before chat moved to its own worker. The chat worker binds this
	// worker as `CORE` and calls these as `env.CORE.ingestUrls(...)`.

	/** Crawl + save external URLs to a user's library; returns created user_file IDs. */
	ingestUrls(urls: string[], userId: string): Promise<string[]> {
		return ingestUrlsForUser(this.env, urls, userId);
	}

	/** Generate an AI illustration, store it, and return its asset URL + model. */
	generateImage(userId: string, prompt: string): Promise<{ assetUrl: string; model: string }> {
		return mediaGenerateImage(this.env, userId, prompt);
	}

	/** Hybrid article search (embeddings + keywords) for the chat search-news tool. */
	searchArticles(query: string, opts?: { daysAgo?: number; limit?: number }): Promise<ArticleSummary[]> {
		return retrievalSearchArticles(this.env, query, opts);
	}

	/** Read article/collection/url resources for the chat read-context tool (documents are read via Vercel). */
	readContextItems(items: ReadContextItem[], userId: string): Promise<ReadContextResult[]> {
		return retrievalReadContextItems(this.env, items, userId);
	}
}
