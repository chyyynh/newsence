import { WorkerEntrypoint } from 'cloudflare:workers';
import { AcademicMetadataBackfillWorkflow, startAcademicMetadataBackfill } from '@ingest/academic-metadata-backfill-workflow';
import { ResourceTranslationWorkflow } from '@ingest/content-localization-workflow';
import { runMonitorCycle } from '@ingest/official-publications';
import { handleRSSCron } from '@ingest/platforms/rss';
import { handleTwitterCron } from '@ingest/platforms/twitter';
import { RecentResourceImageBackfillWorkflow } from '@ingest/resource-image-backfill-workflow';
import { type ResolveSourceCandidateInput, resolveSourceCandidate } from '@ingest/source-discovery';
import { enqueueProcessing, enqueueResourceResync, ResourceProcessingWorkflow } from '@ingest/workflow';
import { SearchIndexRebuildWorkflow, startSearchIndexRebuild } from './ai-search';
import type { ReadContextItem, RelatedResourceSearchInput, ResourceSearchInput } from './corpus';
import { readCorpusItems, relatedCorpusResourceIds, searchCorpusResourceRanks, searchCorpusResources } from './corpus';
import { assertResourceProcessable, isResourceEnrichmentComplete } from './ingest/domain/resource-store';

export {
	AcademicMetadataBackfillWorkflow,
	RecentResourceImageBackfillWorkflow,
	ResourceProcessingWorkflow,
	ResourceTranslationWorkflow,
	SearchIndexRebuildWorkflow,
};

export default class CoreWorker extends WorkerEntrypoint<CoreEnv> {
	override fetch(request: Request): Response {
		const url = new URL(request.url);
		if (request.method === 'GET' && url.pathname === '/health') return Response.json({ status: 'ok' });
		return new Response('Not found', { status: 404 });
	}

	override scheduled(event: ScheduledController): void {
		console.info({ tag: 'CORE', msg: 'Scheduled', cron: event.cron });

		// YouTube channels ride the RSS monitor: their handles are Atom feed URLs,
		// so they are ordinary rss sources with a 30-minute poll interval.
		if (event.cron === '*/5 * * * *') {
			this.ctx.waitUntil(runMonitorCycle(this.env, handleRSSCron));
		} else if (event.cron === '0 */6 * * *') {
			this.ctx.waitUntil(runMonitorCycle(this.env, handleTwitterCron));
		}
	}

	// Service-binding RPC for engine capabilities. Product-domain writes live on
	// the app Worker's DomainRpc binding.

	/** Enqueue canonical resources for the enrichment workflow after app-side persistence. */
	async enqueueResourceProcessing(resourceId: string) {
		if (await isResourceEnrichmentComplete(this.env, resourceId)) return undefined;
		return enqueueProcessing(this.env, resourceId);
	}

	/** Reacquire a URL-backed resource through the enrichment workflow. */
	async resyncResource(resourceId: string) {
		await assertResourceProcessable(this.env, resourceId);
		return enqueueResourceResync(this.env, resourceId);
	}

	/** Start or resume the revision-scoped public corpus AI Search rebuild. */
	startSearchIndexRebuild() {
		return startSearchIndexRebuild(this.env);
	}

	/** Start or resume the versioned academic metadata backfill. */
	startAcademicMetadataBackfill() {
		return startAcademicMetadataBackfill(this.env);
	}

	/** Read academic metadata backfill status for operator polling. */
	async getAcademicMetadataBackfillStatus(instanceId: string) {
		const instance = await this.env.ACADEMIC_METADATA_BACKFILL_WORKFLOW.get(instanceId);
		return instance.status();
	}

	/** Hybrid AI Search retrieval for the chat search-news tool. */
	searchResources(input: ResourceSearchInput) {
		return searchCorpusResources(this.env, input);
	}

	/** Hybrid rank search for app-side feed/context lookup. */
	searchResourceRanks(input: ResourceSearchInput) {
		return searchCorpusResourceRanks(this.env, input);
	}

	/** Related resource ids for app-side recommendations. */
	relatedResourceIds(input: RelatedResourceSearchInput) {
		return relatedCorpusResourceIds(this.env, input);
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

	/** Resolve user input (site/feed/channel URL or handle) into a monitorable source candidate (#237). */
	resolveSourceCandidate(input: ResolveSourceCandidateInput) {
		return resolveSourceCandidate(this.env, input);
	}
}
