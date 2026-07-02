import { WorkerEntrypoint } from 'cloudflare:workers';
import { routeRequest } from '@entry/http';
import { persistGeneratedImage } from '@ingest/blob-persistence';
import { extractSource, type NormalizedContent } from '@ingest/extract';
import { handleRSSCron } from '@ingest/platforms/rss/monitor';
import { handleTwitterCron } from '@ingest/platforms/twitter/monitor';
import { handleYouTubeCron } from '@ingest/platforms/youtube/monitor';
import { handleRetryCron } from '@ingest/retry';
import { NewsenceMonitorWorkflow } from '@ingest/workflows/article-processing.workflow';
import { ScrapeWorkflow } from '@ingest/workflows/scrape.workflow';
import type { Env, ExecutionContext, MessageBatch, ScheduledEvent } from '@shared/types';
import { ensureWorkflowsForQueueMessage, type QueueMessage } from '@shared/workflow-queue';
import type { CoreRpc } from '@worker-contracts/core-rpc';
import { readCorpusItems, searchCorpusArticles } from './corpus';
import {
	addResource,
	addResourceUrlsToSource,
	createDocument,
	createWorkspace,
	createWorkspaceDocument,
	deleteDocument,
	editDocument,
	listWorkspaces,
	readDocuments,
	saveDocument,
	updateDocumentShare,
	workspaceSummary,
} from './documents';
import { deleteUserMediaFile } from './media/delete';

export { NewsenceMonitorWorkflow, ScrapeWorkflow };

type CoreRpcArgs<Method extends keyof CoreRpc> = Parameters<CoreRpc[Method]>;

export default class CoreWorker extends WorkerEntrypoint<Env> implements CoreRpc {
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
	// Thin delegates to core-owned domain facades.

	/** Persist a generated image into the canonical user_file blob store. */
	storeGeneratedImage(input: CoreRpcArgs<'storeGeneratedImage'>[0]) {
		return persistGeneratedImage(this.env, input);
	}

	/** Hybrid article search (embeddings + keywords) for the chat search-news tool. */
	searchArticles(input: CoreRpcArgs<'searchArticles'>[0]) {
		return searchCorpusArticles(this.env, input);
	}

	/** Extract one URL without creating user_files/articles. Intended for future chat agent reads. */
	scrapeUrl(url: CoreRpcArgs<'scrapeUrl'>[0]): Promise<NormalizedContent> {
		return extractSource(this.env, { kind: 'url', url });
	}

	/** Read article/collection/url resources from the core corpus. */
	readCorpusItems(items: CoreRpcArgs<'readCorpusItems'>[0], userId: CoreRpcArgs<'readCorpusItems'>[1]) {
		return readCorpusItems(this.env, items, userId);
	}

	/** Read Tiptap documents as markdown context. */
	readDocuments(userId: CoreRpcArgs<'readDocuments'>[0], ids: CoreRpcArgs<'readDocuments'>[1]) {
		return readDocuments(this.env, userId, ids);
	}

	/** Persist AI-generated markdown into a Tiptap document. */
	createDocument(input: CoreRpcArgs<'createDocument'>[0]) {
		return createDocument(this.env, input);
	}

	/** Create an empty compose-mode document in a workspace. */
	createWorkspaceDocument(input: CoreRpcArgs<'createWorkspaceDocument'>[0]) {
		return createWorkspaceDocument(this.env, input);
	}

	/** Delete a user-owned document. */
	deleteDocument(input: CoreRpcArgs<'deleteDocument'>[0]) {
		return deleteDocument(this.env, input);
	}

	/** Delete a user-owned blob media file and its R2 object. */
	deleteUserMediaFile(input: CoreRpcArgs<'deleteUserMediaFile'>[0]) {
		return deleteUserMediaFile(this.env, input);
	}

	/** Save editor content with optimistic-version checks and snapshots. */
	saveDocument(input: CoreRpcArgs<'saveDocument'>[0]) {
		return saveDocument(this.env, input);
	}

	/** Update public-share settings for a user-owned document. */
	updateDocumentShare(input: CoreRpcArgs<'updateDocumentShare'>[0]) {
		return updateDocumentShare(this.env, input);
	}

	/** Apply str_replace edits to a document. */
	editDocument(input: CoreRpcArgs<'editDocument'>[0]) {
		return editDocument(this.env, input);
	}

	/** Pin article/file/URL resources to a document's workspace. */
	addDocumentResource(input: CoreRpcArgs<'addDocumentResource'>[0]) {
		return addResource(this.env, input);
	}

	/** Ingest URLs and pin the resulting user files to a workspace or collection. */
	addResourceUrlsToSource(input: CoreRpcArgs<'addResourceUrlsToSource'>[0]) {
		return addResourceUrlsToSource(this.env, input);
	}

	/** Workspace catalog used by scope-free create-document decisions. */
	listWorkspaces(userId: CoreRpcArgs<'listWorkspaces'>[0]) {
		return listWorkspaces(this.env, userId);
	}

	/** Create a workspace with core-owned quota enforcement. */
	createWorkspace(input: CoreRpcArgs<'createWorkspace'>[0]) {
		return createWorkspace(this.env, input);
	}

	/** Workspace pinned-resource summary for workspace-scoped chat context. */
	workspaceSummary(userId: CoreRpcArgs<'workspaceSummary'>[0], workspaceId: CoreRpcArgs<'workspaceSummary'>[1]) {
		return workspaceSummary(this.env, userId, workspaceId);
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
