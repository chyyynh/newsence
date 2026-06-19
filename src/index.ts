import { WorkerEntrypoint } from 'cloudflare:workers';
import { routeRequest } from '@entry/http';
import { handleRetryCron } from '@ingest/monitors/retry';
import { handleRSSCron } from '@ingest/platforms/rss/monitor';
import { handleTwitterCron } from '@ingest/platforms/twitter/monitor';
import { handleYouTubeCron } from '@ingest/platforms/youtube/monitor';
import { ingestUrls as ingestUrlsForUser } from '@ingest/urls';
import { NewsenceMonitorWorkflow } from '@ingest/workflows/article-processing.workflow';
import { ScrapeWorkflow } from '@ingest/workflows/scrape.workflow';
import { resolveProcessableTable } from '@shared/db';
import type { Env, MessageBatch, QueueMessage, ScheduledEvent } from '@shared/types';
import { type ArticleSummary, type CorpusReadItem, type CorpusReadResult, readCorpusItems, searchCorpusArticles } from './corpus';

export { NewsenceMonitorWorkflow, ScrapeWorkflow };

async function handleArticleQueue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
	console.info({ tag: 'ARTICLE-QUEUE', msg: 'Received batch', count: batch.messages.length });

	for (const message of batch.messages) {
		const body = message.body;

		try {
			if (body.type !== 'article_process' && body.type !== 'batch_process') {
				console.warn({ tag: 'ARTICLE-QUEUE', msg: 'Unknown message type, acking' });
				message.ack();
				continue;
			}

			const targetTable = resolveProcessableTable(body.target_table);
			const ids = body.type === 'article_process' ? [body.article_id] : body.article_ids;
			for (const id of ids) {
				await env.MONITOR_WORKFLOW.create({
					params: {
						article_id: id,
						target_table: targetTable,
					},
				});
			}
			console.info({ tag: 'ARTICLE-QUEUE', msg: 'Created workflows', count: ids.length });
			message.ack();
		} catch (err) {
			console.error({ tag: 'ARTICLE-QUEUE', msg: 'Error handling message, retrying', error: String(err) });
			message.retry();
		}
	}
}

export default class CoreWorker extends WorkerEntrypoint<Env> {
	override async fetch(request: Request): Promise<Response> {
		return routeRequest(request, this.env, this.ctx);
	}

	scheduled(event: ScheduledEvent): void {
		console.info({ tag: 'CORE', msg: 'Scheduled', cron: event.cron });
		if (event.cron === '*/5 * * * *') this.ctx.waitUntil(handleRSSCron(this.env, this.ctx));
		else if (event.cron === '0 */6 * * *') this.ctx.waitUntil(handleTwitterCron(this.env, this.ctx));
		else if (event.cron === '*/30 * * * *') this.ctx.waitUntil(handleYouTubeCron(this.env, this.ctx));
		else if (event.cron === '0 3 * * *') this.ctx.waitUntil(handleRetryCron(this.env, this.ctx));
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
