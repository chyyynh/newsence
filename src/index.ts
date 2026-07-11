import { WorkerEntrypoint } from 'cloudflare:workers';
import { ResourceTranslationWorkflow } from '@ingest/content-localization-workflow';
import { handleRSSCron } from '@ingest/platforms/rss';
import { handleTwitterCron } from '@ingest/platforms/twitter';
import { handleYouTubeCron } from '@ingest/platforms/youtube';
import { enqueueProcessing, enqueueResourceResync, ResourceProcessingWorkflow } from '@ingest/workflow';
import { SearchIndexRebuildWorkflow, startSearchIndexRebuild } from './ai-search';
import type { ReadContextItem, RelatedResourceSearchInput, ResourceRankSearchInput, ResourceSearchInput } from './corpus';
import { readCorpusItems, relatedCorpusResourceIds, searchCorpusResourceRanks, searchCorpusResources } from './corpus';
import { assertResourceProcessable, isResourceEnrichmentComplete } from './ingest/domain/resource-store';
import { type ExportCollectionOkfInput, exportCollectionOkf } from './okf';

export { ResourceProcessingWorkflow, ResourceTranslationWorkflow, SearchIndexRebuildWorkflow };

export default class CoreWorker extends WorkerEntrypoint<CoreEnv> {
	override fetch(request: Request): Response {
		const url = new URL(request.url);
		if (request.method === 'GET' && url.pathname === '/health') return Response.json({ status: 'ok' });
		return new Response('Not found', { status: 404 });
	}

	override scheduled(event: ScheduledController): void {
		console.info({ tag: 'CORE', msg: 'Scheduled', cron: event.cron });

		if (event.cron === '*/5 * * * *') {
			this.ctx.waitUntil(
				handleRSSCron(this.env).catch((error) => console.error({ tag: 'CORE', msg: 'RSS monitor failed', error: String(error) })),
			);
		} else if (event.cron === '0 */6 * * *') this.ctx.waitUntil(handleTwitterCron(this.env));
		else if (event.cron === '*/30 * * * *') this.ctx.waitUntil(handleYouTubeCron(this.env));
	}

	// Service-binding RPC for engine capabilities. Product-domain writes live on
	// the app Worker's DomainRpc binding.

	/** Enqueue canonical resources for the enrichment workflow after app-side persistence. */
	async enqueueResourceProcessing(resourceId: string) {
		if (await isResourceEnrichmentComplete(this.env, resourceId)) return undefined;
		return enqueueProcessing(this.env, resourceId);
	}

	/** Reacquire a URL-backed resource while preserving the current copy if the source fetch fails. */
	async resyncResource(resourceId: string) {
		await assertResourceProcessable(this.env, resourceId);
		return enqueueResourceResync(this.env, resourceId);
	}

	/** Start or resume the revision-scoped public corpus AI Search rebuild. */
	startSearchIndexRebuild() {
		return startSearchIndexRebuild(this.env);
	}

	/** Hybrid AI Search retrieval for the chat search-news tool. */
	searchResources(input: ResourceSearchInput) {
		return searchCorpusResources(this.env, input);
	}

	/** Hybrid rank search for app-side feed/context lookup. */
	searchResourceRanks(input: ResourceRankSearchInput) {
		return searchCorpusResourceRanks(this.env, input);
	}

	/** Related resource ids for app-side recommendations. */
	relatedResourceIds(input: RelatedResourceSearchInput) {
		return relatedCorpusResourceIds(this.env, input);
	}

	/** Stream a collection as an OKF tar.gz bundle for the app Worker. */
	exportCollectionOkf(input: ExportCollectionOkfInput): Promise<Response> {
		return exportCollectionOkf(this.env, input);
	}

	/** Read workflow status for app-side polling. */
	async getWorkflowStatus(instanceId: string) {
		const instance = await this.env.RESOURCE_PROCESSING_WORKFLOW.get(instanceId);
		return instance.status();
	}

	/** Read collection/resource/url entries from the core corpus. */
	readCorpusItems(items: ReadContextItem[], userId: string) {
		return readCorpusItems(this.env, items, userId);
	}
}
