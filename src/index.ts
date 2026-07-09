import { WorkerEntrypoint } from 'cloudflare:workers';
import { readTextWithLimit } from '@core-shared/web';
import { type AcquiredContent, scrapeSavedUrl, validateAcquisitionUrl } from '@ingest/acquisition';
import {
	AcquisitionWorkflow,
	createAcquisitionJob as createAcquisitionWorkflowJob,
	getAcquisitionJobStatus as readAcquisitionJobStatus,
} from '@ingest/acquisition-workflow';
import { handleRSSCron } from '@ingest/platforms/rss';
import { handleTwitterCron } from '@ingest/platforms/twitter';
import { handleYouTubeCron } from '@ingest/platforms/youtube';
import { enqueueProcessing, NewsenceMonitorWorkflow } from '@ingest/workflow';
import type { ArticleRankSearchInput, ArticleSearchInput, ReadContextItem, RelatedArticleSearchInput } from './corpus';
import { readCorpusItems, relatedCorpusArticleIds, searchCorpusArticleRanks, searchCorpusArticles } from './corpus';
import { isUserFileEnrichmentComplete } from './ingest/domain/article-store';
import { type ExportCollectionOkfInput, exportCollectionOkf } from './okf';

export { AcquisitionWorkflow, NewsenceMonitorWorkflow };

const REQUEST_JSON_MAX_BYTES = 16 * 1024;

function jsonError(status: number, message: string): Response {
	return Response.json({ error: message }, { status });
}

async function readRequestText(request: Request): Promise<string> {
	if (!request.body) return '';
	return readTextWithLimit(new Response(request.body, { headers: request.headers }), REQUEST_JSON_MAX_BYTES);
}

async function readUrlPayload(request: Request): Promise<string> {
	const text = (await readRequestText(request)).trim();
	if (!text) throw new Error('Request body is required');

	const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
	if (!contentType.includes('application/json')) return validateAcquisitionUrl(text);

	const body = JSON.parse(text) as { url?: unknown };
	if (typeof body.url !== 'string' || !body.url.trim()) throw new Error('JSON body must include a url string');
	return validateAcquisitionUrl(body.url.trim());
}

async function handleScrapeRequest(env: CoreEnv, request: Request): Promise<Response> {
	let url: string;
	try {
		url = await readUrlPayload(request);
	} catch (error) {
		return jsonError(400, error instanceof Error ? error.message : 'Invalid scrape request');
	}

	try {
		return Response.json(await scrapeSavedUrl(url, env));
	} catch (error) {
		return jsonError(502, error instanceof Error ? error.message : 'Scrape failed');
	}
}

async function handleCreateAcquisitionJob(env: CoreEnv, request: Request): Promise<Response> {
	let url: string;
	try {
		url = await readUrlPayload(request);
	} catch (error) {
		return jsonError(400, error instanceof Error ? error.message : 'Invalid acquisition request');
	}
	return Response.json(await createAcquisitionWorkflowJob(env, url), { status: 202 });
}

async function handleAcquisitionStatus(env: CoreEnv, instanceId: string | null): Promise<Response> {
	if (!instanceId) return jsonError(400, 'Acquisition workflow id is required');
	return Response.json(await readAcquisitionJobStatus(env, instanceId));
}

export default class CoreWorker extends WorkerEntrypoint<CoreEnv> {
	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === 'POST' && url.pathname === '/scrape') return handleScrapeRequest(this.env, request);
		if (request.method === 'POST' && url.pathname === '/acquisition') return handleCreateAcquisitionJob(this.env, request);
		if (request.method === 'GET' && url.pathname.startsWith('/acquisition/')) {
			return handleAcquisitionStatus(this.env, url.pathname.split('/').filter(Boolean)[1] ?? null);
		}
		if (request.method === 'GET' && url.pathname === '/acquisition') {
			return handleAcquisitionStatus(this.env, url.searchParams.get('id'));
		}
		return new Response('Not found', { status: 404 });
	}

	override scheduled(event: ScheduledController): void {
		console.info({ tag: 'CORE', msg: 'Scheduled', cron: event.cron });

		if (event.cron === '*/5 * * * *') this.ctx.waitUntil(handleRSSCron(this.env));
		else if (event.cron === '0 */6 * * *') this.ctx.waitUntil(handleTwitterCron(this.env));
		else if (event.cron === '*/30 * * * *') this.ctx.waitUntil(handleYouTubeCron(this.env));
	}

	// Service-binding RPC for engine capabilities. Product-domain writes live on
	// the app Worker's DomainRpc binding.

	/** Enqueue saved user_files for the enrichment workflow after app-side persistence. */
	async enqueueUserFileProcessing(userFileId: string) {
		if (await isUserFileEnrichmentComplete(this.env, userFileId)) return undefined;
		return enqueueProcessing(this.env, { kind: 'userFile', rowId: userFileId });
	}

	/** Synchronously acquire one URL without DB persistence. */
	scrapeUrl(url: string): Promise<AcquiredContent | null> {
		return scrapeSavedUrl(url, this.env);
	}

	/** Start a durable acquisition job for external pollers. */
	createAcquisitionJob(url: string) {
		return createAcquisitionWorkflowJob(this.env, url);
	}

	/** Read durable acquisition job status and output. */
	getAcquisitionJobStatus(instanceId: string) {
		return readAcquisitionJobStatus(this.env, instanceId);
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

	/** Read workflow status for app-side polling. */
	async getWorkflowStatus(instanceId: string) {
		const instance = await this.env.MONITOR_WORKFLOW.get(instanceId);
		return instance.status();
	}

	/** Read article/collection/url resources from the core corpus. */
	readCorpusItems(items: ReadContextItem[], userId: string) {
		return readCorpusItems(this.env, items, userId);
	}
}
