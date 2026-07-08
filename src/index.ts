import { WorkerEntrypoint } from 'cloudflare:workers';
import type {
	ArticleRankSearchInput,
	ArticleSearchInput,
	CoreRpc,
	ExportCollectionOkfInput,
	ReadContextItem,
	RelatedArticleSearchInput,
} from '@core-rpc/contracts';
import { handleRSSCron } from '@ingest/platforms/rss/monitor';
import { handleTwitterCron } from '@ingest/platforms/twitter/monitor';
import { handleYouTubeCron } from '@ingest/platforms/youtube/monitor';
import { enqueueProcessing, handleRetryCron, NewsenceMonitorWorkflow, streamWorkflowStatus } from '@ingest/workflow';
import { readCorpusItems, relatedCorpusArticleIds, searchCorpusArticleRanks, searchCorpusArticles } from './corpus';
import { exportCollectionOkf } from './okf';

export { NewsenceMonitorWorkflow };

export default class CoreWorker extends WorkerEntrypoint<Env> implements CoreRpc {
	override async fetch(): Promise<Response> {
		return Response.json({
			status: 'ok',
			worker: 'newsence-core',
			timestamp: new Date().toISOString(),
		});
	}

	override scheduled(event: ScheduledController): void {
		console.info({ tag: 'CORE', msg: 'Scheduled', cron: event.cron });

		if (event.cron === '*/5 * * * *') this.ctx.waitUntil(handleRSSCron(this.env));
		else if (event.cron === '0 */6 * * *') this.ctx.waitUntil(handleTwitterCron(this.env));
		else if (event.cron === '*/30 * * * *') this.ctx.waitUntil(handleYouTubeCron(this.env));
		else if (event.cron === '0 3 * * *') this.ctx.waitUntil(handleRetryCron(this.env));
	}

	// ── Service-binding RPC for engine capabilities ─────────────────────────
	// Product-domain writes live on the app Worker's DomainRpc binding.

	/** Enqueue saved user_files for the enrichment workflow after app-side persistence. */
	enqueueUserFileProcessing(userFileId: string) {
		return enqueueProcessing(this.env, { kind: 'userFile', userFileId });
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

	/** Stream a collection as an OKF tar.gz bundle for the app Worker. */
	exportCollectionOkf(input: ExportCollectionOkfInput): Promise<Response> {
		return exportCollectionOkf(this.env, input);
	}

	/** Stream workflow status updates for app-side SSE endpoints. */
	streamWorkflowStatus(instanceId: string): Promise<Response> {
		return Promise.resolve(streamWorkflowStatus(this.env, instanceId));
	}

	/** Read article/collection/url resources from the core corpus. */
	readCorpusItems(items: ReadContextItem[], userId: string) {
		return readCorpusItems(this.env, items, userId);
	}
}
