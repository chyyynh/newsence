import { WorkerEntrypoint } from 'cloudflare:workers';
import { timingSafeEqual } from 'node:crypto';
import { readTextWithLimit } from '@core-shared/web';
import {
	type AcquiredContent,
	type BlobAcquisitionInput,
	scrapeBlob as scrapeBlobContent,
	scrapeSavedUrl,
	validateAcquisitionUrl,
} from '@ingest/acquisition';
import {
	AcquisitionWorkflow,
	createAcquisitionJob as createAcquisitionWorkflowJob,
	getAcquisitionJobStatus as readAcquisitionJobStatus,
} from '@ingest/acquisition-workflow';
import { ContentLocalizationWorkflow, scheduleContentLocalization } from '@ingest/content-localization-workflow';
import { handleRSSCron } from '@ingest/platforms/rss';
import { handleTwitterCron } from '@ingest/platforms/twitter';
import { handleYouTubeCron } from '@ingest/platforms/youtube';
import { enqueueProcessing, enqueueResourceResync, NewsenceMonitorWorkflow } from '@ingest/workflow';
import type { ReadContextItem, RelatedResourceSearchInput, ResourceRankSearchInput, ResourceSearchInput } from './corpus';
import { readCorpusItems, relatedCorpusResourceIds, searchCorpusResourceRanks, searchCorpusResources } from './corpus';
import { isResourceEnrichmentComplete } from './ingest/domain/resource-store';
import { type ExportCollectionOkfInput, exportCollectionOkf } from './okf';

export { AcquisitionWorkflow, ContentLocalizationWorkflow, NewsenceMonitorWorkflow };

const REQUEST_JSON_MAX_BYTES = 16 * 1024;
const AUTH_ENCODER = new TextEncoder();
const HTTP_CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, X-Internal-Token, Authorization',
};

function jsonError(status: number, message: string): Response {
	return Response.json({ error: message }, { status, headers: HTTP_CORS_HEADERS });
}

function isHttpEnginePath(pathname: string): boolean {
	return pathname === '/scrape' || pathname === '/acquisition' || pathname.startsWith('/acquisition/');
}

async function requireHttpAuth(env: CoreEnv, request: Request): Promise<Response | null> {
	const expected = env.CORE_WORKER_INTERNAL_TOKEN?.trim();
	const provided = (
		request.headers.get('x-internal-token') ??
		request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
		''
	).trim();
	if (!expected) {
		console.error({ tag: 'AUTH', msg: 'CORE_WORKER_INTERNAL_TOKEN is not configured' });
		return jsonError(401, 'Missing or invalid internal token');
	}
	if (!provided) return jsonError(401, 'Missing or invalid internal token');

	const [providedHash, expectedHash] = await Promise.all([
		crypto.subtle.digest('SHA-256', AUTH_ENCODER.encode(provided)),
		crypto.subtle.digest('SHA-256', AUTH_ENCODER.encode(expected)),
	]);
	return timingSafeEqual(new Uint8Array(providedHash), new Uint8Array(expectedHash))
		? null
		: jsonError(401, 'Missing or invalid internal token');
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
		return Response.json(await scrapeSavedUrl(url, env), { headers: HTTP_CORS_HEADERS });
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
	return Response.json(await createAcquisitionWorkflowJob(env, url), { status: 202, headers: HTTP_CORS_HEADERS });
}

async function handleAcquisitionStatus(env: CoreEnv, instanceId: string | null): Promise<Response> {
	if (!instanceId) return jsonError(400, 'Acquisition workflow id is required');
	return Response.json(await readAcquisitionJobStatus(env, instanceId), { headers: HTTP_CORS_HEADERS });
}

export default class CoreWorker extends WorkerEntrypoint<CoreEnv> {
	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === 'GET' && url.pathname === '/health') return Response.json({ status: 'ok' });
		if (request.method === 'OPTIONS' && isHttpEnginePath(url.pathname)) return new Response(null, { headers: HTTP_CORS_HEADERS });
		if (isHttpEnginePath(url.pathname)) {
			const unauthorized = await requireHttpAuth(this.env, request);
			if (unauthorized) return unauthorized;
		}
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

		if (event.cron === '*/5 * * * *') {
			this.ctx.waitUntil(
				handleRSSCron(this.env).catch((error) => console.error({ tag: 'CORE', msg: 'RSS monitor failed', error: String(error) })),
			);
		} else if (event.cron === '* * * * *') {
			this.ctx.waitUntil(
				scheduleContentLocalization(this.env).catch((error) =>
					console.error({ tag: 'CORE', msg: 'Content localization sweep failed', error: String(error) }),
				),
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
		return enqueueResourceResync(this.env, resourceId);
	}

	/** Synchronously acquire one URL without DB persistence. */
	scrapeUrl(url: string): Promise<AcquiredContent> {
		return scrapeSavedUrl(url, this.env);
	}

	/** Synchronously acquire one uploaded blob without DB persistence. */
	scrapeBlob(input: BlobAcquisitionInput): Promise<AcquiredContent> {
		return scrapeBlobContent(input, this.env);
	}

	/** Start a durable acquisition job for external pollers. */
	createAcquisitionJob(url: string) {
		return createAcquisitionWorkflowJob(this.env, url);
	}

	/** Read durable acquisition job status and output. */
	getAcquisitionJobStatus(instanceId: string) {
		return readAcquisitionJobStatus(this.env, instanceId);
	}

	/** Hybrid resource search (embeddings + keywords) for the chat search-news tool. */
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
		const instance = await this.env.MONITOR_WORKFLOW.get(instanceId);
		return instance.status();
	}

	/** Read collection/resource/url entries from the core corpus. */
	readCorpusItems(items: ReadContextItem[], userId: string) {
		return readCorpusItems(this.env, items, userId);
	}
}
