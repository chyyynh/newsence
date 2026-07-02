import { handleIngest } from '@ingest/handlers/ingest';
import { handleScrape, handleScrapeJobCreate, handleScrapeJobStatus } from '@ingest/handlers/scrape';
import { handleRetryCron } from '@ingest/retry';
import { handleDeleteAsset, handleDeleteUserMediaFile } from '@media/delete';
import { handleProxy } from '@media/proxy';
import { handleR2Asset } from '@media/r2-asset';
import { USER_FILES_TABLE } from '@shared/article-store';
import { jsonData, jsonError, parseJsonBody, requireAuth } from '@shared/auth';
import type { Env, ExecutionContext } from '@shared/types';
import { enqueueArticleBatchProcess } from '@shared/workflow-queue';
import type { JsonValue } from '@worker-contracts/core-rpc';
import { relatedCorpusArticleIds, searchCorpusArticleRanks } from '../corpus';
import {
	addResourceToSource,
	addResourceUrlsToSource,
	createWorkspace,
	createWorkspaceDocument,
	DocumentEmptyContentBlockedError,
	DocumentVersionConflictError,
	deleteDocument,
	deleteResource,
	removeResourceFromSource,
	saveDocument,
	updateDocumentShare,
	validateResourceSource,
	WORKSPACE_QUOTA_EXCEEDED_MESSAGE,
} from '../documents';
import { handleExportCollectionOkf } from '../okf';

type RouteHandler = (request: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;

const INTERNAL_CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, X-Internal-Token, Authorization',
};

const POST_ROUTES: Record<string, RouteHandler> = {
	'/search': (req, env) => handleSearch(req, env),
	'/search/related': (req, env) => handleRelated(req, env),
	'/ingest': (req, env) => handleIngest(req, env),
	'/retry': (req, env, ctx) => handleRetry(req, env, ctx),
	'/scrape': (req, env) => handleScrape(req, env),
	'/scrape/jobs': (req, env) => handleScrapeJobCreate(req, env),
	'/workspaces/create': (req, env) => handleCreateWorkspace(req, env),
	'/resources/add': (req, env) => handleAddResourceToSource(req, env),
	'/resources/add-urls': (req, env) => handleAddResourceUrls(req, env),
	'/resources/delete': (req, env) => handleDeleteResource(req, env),
	'/resources/remove': (req, env) => handleRemoveResourceFromSource(req, env),
	'/resources/validate-source': (req, env) => handleValidateResourceSource(req, env),
	'/documents/create': (req, env) => handleCreateWorkspaceDocument(req, env),
	'/documents/delete': (req, env) => handleDeleteDocument(req, env),
	'/documents/save': (req, env) => handleSaveDocument(req, env),
	'/documents/share': (req, env) => handleUpdateDocumentShare(req, env),
	'/okf/collections/export': (req, env) => handleExportCollectionOkf(req, env),
	'/media/delete-user-file': (req, env) => handleDeleteUserMediaFile(req, env),
	'/media/delete': (req, env) => handleDeleteAsset(req, env),
};

const OPTIONS_ROUTES: Record<string, RouteHandler> = {
	'/search': (req, env) => handleSearch(req, env),
	'/search/related': (req, env) => handleRelated(req, env),
	'/scrape': (req, env) => handleScrape(req, env),
	'/scrape/jobs': (req, env) => handleScrapeJobCreate(req, env),
	'/workspaces/create': (req, env) => handleCreateWorkspace(req, env),
	'/resources/add': (req, env) => handleAddResourceToSource(req, env),
	'/resources/add-urls': (req, env) => handleAddResourceUrls(req, env),
	'/resources/delete': (req, env) => handleDeleteResource(req, env),
	'/resources/remove': (req, env) => handleRemoveResourceFromSource(req, env),
	'/resources/validate-source': (req, env) => handleValidateResourceSource(req, env),
	'/documents/create': (req, env) => handleCreateWorkspaceDocument(req, env),
	'/documents/delete': (req, env) => handleDeleteDocument(req, env),
	'/documents/save': (req, env) => handleSaveDocument(req, env),
	'/documents/share': (req, env) => handleUpdateDocumentShare(req, env),
	'/okf/collections/export': (req, env) => handleExportCollectionOkf(req, env),
	// handleDeleteUserMediaFile has no OPTIONS branch; answer the preflight here.
	'/media/delete-user-file': () => new Response(null, { headers: INTERNAL_CORS_HEADERS }),
};

const HELP_TEXT =
	'Newsence Core Worker\n\n' +
	'HTTP endpoints (frontend):\n' +
	'GET  /health\n' +
	'POST /ingest                              - Ingest URL (JSON), image URL (JSON), or user-uploaded blob (multipart)\n' +
	'POST /retry                               - Internal: enqueue article/user_file workflow retries\n' +
	'POST /scrape                              - Sync extraction: {url} JSON or raw bytes -> NormalizedContent {markdown,text,metadata,status}\n' +
	'POST /scrape/jobs                         - Async parse job (non-persisting): {url} or raw bytes -> {jobId}\n' +
	'GET  /scrape/jobs/:id                     - Poll parse job -> {status, result?, error?}\n' +
	'POST /search                              - Hybrid corpus ranking (internal token) -> {success,data:{results}}\n' +
	'POST /search/related                      - pgvector neighbours of a seed (internal token) -> {success,data:{ids}}\n' +
	'POST /workspaces/create                   - Create a user workspace (internal token) -> {success,data:{id}}\n' +
	'POST /resources/add                       - Pin a resource target to a workspace/collection (internal token) -> {success,data}\n' +
	'POST /resources/add-urls                  - Ingest URLs and pin user files to a workspace/collection (internal token) -> {success,data}\n' +
	'POST /resources/delete                    - Remove a user-owned citation by citation id (internal token) -> {success,data:{id}}\n' +
	'POST /resources/remove                    - Remove a user-owned citation by source/target (internal token) -> {success,data:{id}}\n' +
	'POST /resources/validate-source           - Validate source ownership before upload/linking (internal token) -> {success,data}\n' +
	'POST /documents/create                    - Create an empty workspace document (internal token) -> {success,data}\n' +
	'POST /documents/delete                    - Delete a user-owned document (internal token) -> {success,data:{id}}\n' +
	'POST /documents/save                      - Save editor content and snapshot previous versions (internal token) -> {success,data}\n' +
	'POST /documents/share                     - Update document share settings (internal token) -> {success,data}\n' +
	'POST /okf/collections/export              - Export a collection as OKF tar.gz (internal token) -> gzip stream\n' +
	'POST /media/delete-user-file              - Delete a user-owned blob user_file and R2 object (internal token) -> {success,data}\n' +
	'POST /media/delete                        - Batch-delete user-file R2 objects by storage key (#162) -> {success,data}\n' +
	'GET  /stream/:instanceId                  - Workflow status (SSE, internal token)\n' +
	'\nSigned media:\n' +
	'GET  /media/external/{options}/{mediaUrl} - Upstream image/video passthrough with edge cache\n' +
	'GET  /media/asset/{key}?sig=&exp=         - Authenticated R2 asset\n';

function scrapeJobId(pathname: string): string | null {
	if (!pathname.startsWith('/scrape/jobs/')) return null;
	return pathname.slice('/scrape/jobs/'.length) || null;
}

function isResourceTargetType(value: unknown): value is 'article' | 'user_file' | 'document' | 'collection' {
	return value === 'article' || value === 'user_file' || value === 'document' || value === 'collection';
}

function isResourceSourceType(value: unknown): value is 'workspace' | 'collection' | 'user' {
	return value === 'workspace' || value === 'collection' || value === 'user';
}

function health(): Response {
	return Response.json({
		status: 'ok',
		worker: 'newsence-core',
		timestamp: new Date().toISOString(),
	});
}

async function handleSearch(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { headers: INTERNAL_CORS_HEADERS });

	const unauth = await requireAuth(request, env, INTERNAL_CORS_HEADERS);
	if (unauth) return unauth;

	const body = await parseJsonBody<{ query?: string; limit?: number }>(request, INTERNAL_CORS_HEADERS);
	if (body instanceof Response) return body;

	if (!body.query?.trim()) {
		return jsonData({ results: [] }, INTERNAL_CORS_HEADERS);
	}

	try {
		const results = await searchCorpusArticleRanks(env, { query: body.query, limit: body.limit });
		return jsonData({ results }, INTERNAL_CORS_HEADERS);
	} catch (error) {
		console.error({ tag: 'SEARCH', msg: 'hybrid search failed', error: error instanceof Error ? error.message : String(error) });
		return jsonError('SEARCH_FAILED', 'Search failed', 500, INTERNAL_CORS_HEADERS);
	}
}

async function handleRelated(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { headers: INTERNAL_CORS_HEADERS });

	const unauth = await requireAuth(request, env, INTERNAL_CORS_HEADERS);
	if (unauth) return unauth;

	const body = await parseJsonBody<{ id?: string; type?: string; limit?: number; offset?: number }>(request, INTERNAL_CORS_HEADERS);
	if (body instanceof Response) return body;

	if (!body.id?.trim()) {
		return jsonError('BAD_REQUEST', 'Missing seed id', 400, INTERNAL_CORS_HEADERS);
	}
	const type = body.type === 'user_file' ? 'user_file' : 'article';

	try {
		const ids = await relatedCorpusArticleIds(env, { seed: { id: body.id, type }, limit: body.limit, offset: body.offset });
		return jsonData({ ids }, INTERNAL_CORS_HEADERS);
	} catch (error) {
		console.error({ tag: 'SEARCH', msg: 'related search failed', error: error instanceof Error ? error.message : String(error) });
		return jsonError('SEARCH_FAILED', 'Related search failed', 500, INTERNAL_CORS_HEADERS);
	}
}

async function handleCreateWorkspace(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { headers: INTERNAL_CORS_HEADERS });

	const unauth = await requireAuth(request, env, INTERNAL_CORS_HEADERS);
	if (unauth) return unauth;

	const body = await parseJsonBody<{ userId?: string; title?: string; description?: string | null }>(request, INTERNAL_CORS_HEADERS);
	if (body instanceof Response) return body;

	if (!body.userId?.trim() || !body.title?.trim()) {
		return jsonError('BAD_REQUEST', 'Missing userId or title', 400, INTERNAL_CORS_HEADERS);
	}

	try {
		const result = await createWorkspace(env, {
			userId: body.userId,
			title: body.title,
			description: body.description,
		});
		return jsonData(result, INTERNAL_CORS_HEADERS);
	} catch (error) {
		if (error instanceof Error && error.message === WORKSPACE_QUOTA_EXCEEDED_MESSAGE) {
			return jsonError('WORKSPACE_QUOTA_EXCEEDED', error.message, 403, INTERNAL_CORS_HEADERS);
		}
		console.error({ tag: 'WORKSPACE_CREATE', msg: 'create failed', error: error instanceof Error ? error.message : String(error) });
		return jsonError('INTERNAL_ERROR', 'Workspace create failed', 500, INTERNAL_CORS_HEADERS);
	}
}

async function handleAddResourceUrls(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { headers: INTERNAL_CORS_HEADERS });

	const unauth = await requireAuth(request, env, INTERNAL_CORS_HEADERS);
	if (unauth) return unauth;

	const body = await parseJsonBody<{
		userId?: string;
		sourceType?: string;
		sourceId?: string;
		urls?: string[];
	}>(request, INTERNAL_CORS_HEADERS);
	if (body instanceof Response) return body;

	if (
		!body.userId?.trim() ||
		(body.sourceType !== 'workspace' && body.sourceType !== 'collection') ||
		!body.sourceId?.trim() ||
		!Array.isArray(body.urls)
	) {
		return jsonError('BAD_REQUEST', 'Missing userId, source, or urls', 400, INTERNAL_CORS_HEADERS);
	}

	try {
		const result = await addResourceUrlsToSource(env, {
			userId: body.userId,
			sourceType: body.sourceType,
			sourceId: body.sourceId,
			urls: body.urls,
		});
		return jsonData(result, INTERNAL_CORS_HEADERS);
	} catch (error) {
		if (error instanceof Error && error.message === 'Source not found') {
			return jsonError('NOT_FOUND', error.message, 404, INTERNAL_CORS_HEADERS);
		}
		if (error instanceof Error && error.message === 'Add at least one valid URL') {
			return jsonError('BAD_REQUEST', error.message, 400, INTERNAL_CORS_HEADERS);
		}
		console.error({ tag: 'RESOURCE_ADD_URLS', msg: 'add urls failed', error: error instanceof Error ? error.message : String(error) });
		return jsonError('INTERNAL_ERROR', 'Resource URL add failed', 500, INTERNAL_CORS_HEADERS);
	}
}

async function handleAddResourceToSource(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { headers: INTERNAL_CORS_HEADERS });

	const unauth = await requireAuth(request, env, INTERNAL_CORS_HEADERS);
	if (unauth) return unauth;

	const body = await parseJsonBody<{
		userId?: string;
		sourceType?: string;
		sourceId?: string;
		targetType?: string;
		targetId?: string;
	}>(request, INTERNAL_CORS_HEADERS);
	if (body instanceof Response) return body;

	if (
		!body.userId?.trim() ||
		!isResourceSourceType(body.sourceType) ||
		!body.sourceId?.trim() ||
		!isResourceTargetType(body.targetType) ||
		!body.targetId?.trim()
	) {
		return jsonError('BAD_REQUEST', 'Missing source or target', 400, INTERNAL_CORS_HEADERS);
	}

	try {
		const result = await addResourceToSource(env, {
			userId: body.userId,
			sourceType: body.sourceType,
			sourceId: body.sourceId,
			targetType: body.targetType,
			targetId: body.targetId,
		});
		return jsonData(result, INTERNAL_CORS_HEADERS);
	} catch (error) {
		if (error instanceof Error && error.message === 'Resource not found') {
			return jsonError('NOT_FOUND', error.message, 404, INTERNAL_CORS_HEADERS);
		}
		console.error({ tag: 'RESOURCE_ADD', msg: 'add failed', error: error instanceof Error ? error.message : String(error) });
		return jsonError('INTERNAL_ERROR', 'Resource add failed', 500, INTERNAL_CORS_HEADERS);
	}
}

async function handleDeleteResource(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { headers: INTERNAL_CORS_HEADERS });

	const unauth = await requireAuth(request, env, INTERNAL_CORS_HEADERS);
	if (unauth) return unauth;

	const body = await parseJsonBody<{ userId?: string; citationId?: string }>(request, INTERNAL_CORS_HEADERS);
	if (body instanceof Response) return body;

	if (!body.userId?.trim() || !body.citationId?.trim()) {
		return jsonError('BAD_REQUEST', 'Missing userId or citationId', 400, INTERNAL_CORS_HEADERS);
	}

	try {
		const result = await deleteResource(env, { userId: body.userId, citationId: body.citationId });
		return jsonData(result, INTERNAL_CORS_HEADERS);
	} catch (error) {
		if (error instanceof Error && error.message === 'Resource not found') {
			return jsonError('NOT_FOUND', error.message, 404, INTERNAL_CORS_HEADERS);
		}
		console.error({ tag: 'RESOURCE_DELETE', msg: 'delete failed', error: error instanceof Error ? error.message : String(error) });
		return jsonError('INTERNAL_ERROR', 'Resource delete failed', 500, INTERNAL_CORS_HEADERS);
	}
}

async function handleRemoveResourceFromSource(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { headers: INTERNAL_CORS_HEADERS });

	const unauth = await requireAuth(request, env, INTERNAL_CORS_HEADERS);
	if (unauth) return unauth;

	const body = await parseJsonBody<{
		userId?: string;
		sourceType?: string;
		sourceId?: string;
		targetType?: string;
		targetId?: string;
	}>(request, INTERNAL_CORS_HEADERS);
	if (body instanceof Response) return body;

	if (
		!body.userId?.trim() ||
		!isResourceSourceType(body.sourceType) ||
		!body.sourceId?.trim() ||
		!isResourceTargetType(body.targetType) ||
		!body.targetId?.trim()
	) {
		return jsonError('BAD_REQUEST', 'Missing source or target', 400, INTERNAL_CORS_HEADERS);
	}

	try {
		const result = await removeResourceFromSource(env, {
			userId: body.userId,
			sourceType: body.sourceType,
			sourceId: body.sourceId,
			targetType: body.targetType,
			targetId: body.targetId,
		});
		return jsonData(result, INTERNAL_CORS_HEADERS);
	} catch (error) {
		if (error instanceof Error && error.message === 'Resource not found') {
			return jsonError('NOT_FOUND', error.message, 404, INTERNAL_CORS_HEADERS);
		}
		console.error({ tag: 'RESOURCE_REMOVE', msg: 'remove failed', error: error instanceof Error ? error.message : String(error) });
		return jsonError('INTERNAL_ERROR', 'Resource remove failed', 500, INTERNAL_CORS_HEADERS);
	}
}

async function handleValidateResourceSource(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { headers: INTERNAL_CORS_HEADERS });

	const unauth = await requireAuth(request, env, INTERNAL_CORS_HEADERS);
	if (unauth) return unauth;

	const body = await parseJsonBody<{
		userId?: string;
		sourceType?: string;
		sourceId?: string;
	}>(request, INTERNAL_CORS_HEADERS);
	if (body instanceof Response) return body;

	if (!body.userId?.trim() || !isResourceSourceType(body.sourceType) || !body.sourceId?.trim()) {
		return jsonError('BAD_REQUEST', 'Missing source', 400, INTERNAL_CORS_HEADERS);
	}

	try {
		const result = await validateResourceSource(env, {
			userId: body.userId,
			sourceType: body.sourceType,
			sourceId: body.sourceId,
		});
		return jsonData(result, INTERNAL_CORS_HEADERS);
	} catch (error) {
		if (error instanceof Error && error.message === 'Source not found') {
			return jsonError('NOT_FOUND', error.message, 404, INTERNAL_CORS_HEADERS);
		}
		console.error({
			tag: 'RESOURCE_VALIDATE_SOURCE',
			msg: 'validate source failed',
			error: error instanceof Error ? error.message : String(error),
		});
		return jsonError('INTERNAL_ERROR', 'Resource source validation failed', 500, INTERNAL_CORS_HEADERS);
	}
}

async function handleCreateWorkspaceDocument(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { headers: INTERNAL_CORS_HEADERS });

	const unauth = await requireAuth(request, env, INTERNAL_CORS_HEADERS);
	if (unauth) return unauth;

	const body = await parseJsonBody<{ userId?: string; workspaceId?: string; title?: string }>(request, INTERNAL_CORS_HEADERS);
	if (body instanceof Response) return body;

	if (!body.userId?.trim() || !body.workspaceId?.trim()) {
		return jsonError('BAD_REQUEST', 'Missing userId or workspaceId', 400, INTERNAL_CORS_HEADERS);
	}

	try {
		const result = await createWorkspaceDocument(env, { userId: body.userId, workspaceId: body.workspaceId, title: body.title });
		return jsonData(result, INTERNAL_CORS_HEADERS);
	} catch (error) {
		if (error instanceof Error && error.message === 'Workspace not found') {
			return jsonError('NOT_FOUND', 'Workspace not found', 404, INTERNAL_CORS_HEADERS);
		}
		console.error({ tag: 'DOCUMENT_CREATE', msg: 'create failed', error: error instanceof Error ? error.message : String(error) });
		return jsonError('INTERNAL_ERROR', 'Document create failed', 500, INTERNAL_CORS_HEADERS);
	}
}

async function handleDeleteDocument(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { headers: INTERNAL_CORS_HEADERS });

	const unauth = await requireAuth(request, env, INTERNAL_CORS_HEADERS);
	if (unauth) return unauth;

	const body = await parseJsonBody<{ userId?: string; documentId?: string }>(request, INTERNAL_CORS_HEADERS);
	if (body instanceof Response) return body;

	if (!body.userId?.trim() || !body.documentId?.trim()) {
		return jsonError('BAD_REQUEST', 'Missing userId or documentId', 400, INTERNAL_CORS_HEADERS);
	}

	try {
		const result = await deleteDocument(env, { userId: body.userId, documentId: body.documentId });
		return jsonData(result, INTERNAL_CORS_HEADERS);
	} catch (error) {
		if (error instanceof Error && error.message === 'Document not found') {
			return jsonError('NOT_FOUND', 'Document not found', 404, INTERNAL_CORS_HEADERS);
		}
		console.error({ tag: 'DOCUMENT_DELETE', msg: 'delete failed', error: error instanceof Error ? error.message : String(error) });
		return jsonError('INTERNAL_ERROR', 'Document delete failed', 500, INTERNAL_CORS_HEADERS);
	}
}

async function handleSaveDocument(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { headers: INTERNAL_CORS_HEADERS });

	const unauth = await requireAuth(request, env, INTERNAL_CORS_HEADERS);
	if (unauth) return unauth;

	const body = await parseJsonBody<{
		userId?: string;
		documentId?: string;
		title?: string;
		content?: unknown;
		allowEmptyContentOverwrite?: boolean;
		expectedVersion?: number;
		source?: 'auto-save' | 'ai-edit' | 'restore';
		forceSnapshot?: boolean;
	}>(request, INTERNAL_CORS_HEADERS);
	if (body instanceof Response) return body;

	if (!body.userId?.trim() || !body.documentId?.trim() || typeof body.title !== 'string' || body.content === undefined) {
		return jsonError('BAD_REQUEST', 'Missing userId, documentId, title, or content', 400, INTERNAL_CORS_HEADERS);
	}

	try {
		const result = await saveDocument(env, {
			userId: body.userId,
			documentId: body.documentId,
			title: body.title,
			content: body.content as JsonValue,
			allowEmptyContentOverwrite: body.allowEmptyContentOverwrite,
			expectedVersion: body.expectedVersion,
			source: body.source,
			forceSnapshot: body.forceSnapshot,
		});
		return jsonData(result, INTERNAL_CORS_HEADERS);
	} catch (error) {
		if (error instanceof DocumentVersionConflictError) {
			return jsonError('DOCUMENT_VERSION_CONFLICT', error.message, 409, INTERNAL_CORS_HEADERS, {
				clientVersion: error.clientVersion,
				serverVersion: error.serverVersion,
			});
		}
		if (error instanceof DocumentEmptyContentBlockedError) {
			return jsonError('EMPTY_CONTENT_BLOCKED', error.message, 409, INTERNAL_CORS_HEADERS);
		}
		if (error instanceof Error) {
			if (error.message === 'Document not found') return jsonError('NOT_FOUND', error.message, 404, INTERNAL_CORS_HEADERS);
			if (error.message === 'Images are still uploading') return jsonError('BAD_REQUEST', error.message, 400, INTERNAL_CORS_HEADERS);
		}
		console.error({ tag: 'DOCUMENT_SAVE', msg: 'save failed', error: error instanceof Error ? error.message : String(error) });
		return jsonError('INTERNAL_ERROR', 'Document save failed', 500, INTERNAL_CORS_HEADERS);
	}
}

async function handleUpdateDocumentShare(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { headers: INTERNAL_CORS_HEADERS });

	const unauth = await requireAuth(request, env, INTERNAL_CORS_HEADERS);
	if (unauth) return unauth;

	const body = await parseJsonBody<{
		userId?: string;
		documentId?: string;
		shareEnabled?: boolean;
		shareSlug?: string | null;
		description?: string | null;
	}>(request, INTERNAL_CORS_HEADERS);
	if (body instanceof Response) return body;

	if (!body.userId?.trim() || !body.documentId?.trim() || typeof body.shareEnabled !== 'boolean') {
		return jsonError('BAD_REQUEST', 'Missing userId, documentId, or shareEnabled', 400, INTERNAL_CORS_HEADERS);
	}

	try {
		const result = await updateDocumentShare(env, {
			userId: body.userId,
			documentId: body.documentId,
			shareEnabled: body.shareEnabled,
			shareSlug: body.shareSlug,
			description: body.description,
		});
		return jsonData(result, INTERNAL_CORS_HEADERS);
	} catch (error) {
		if (error instanceof Error) {
			if (
				error.message === 'Document not found' ||
				error.message === 'Set a username before sharing.' ||
				error.message === 'Invalid share URL.' ||
				error.message === 'This URL is already in use.'
			) {
				return error.message === 'Document not found'
					? jsonError('NOT_FOUND', error.message, 404, INTERNAL_CORS_HEADERS)
					: jsonError('BAD_REQUEST', error.message, 400, INTERNAL_CORS_HEADERS);
			}
		}
		console.error({ tag: 'DOCUMENT_SHARE', msg: 'update failed', error: error instanceof Error ? error.message : String(error) });
		return jsonError('INTERNAL_ERROR', 'Document share update failed', 500, INTERNAL_CORS_HEADERS);
	}
}

async function handleRetry(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { headers: INTERNAL_CORS_HEADERS });

	const unauth = await requireAuth(request, env, INTERNAL_CORS_HEADERS);
	if (unauth) return unauth;

	const body = await parseJsonBody<{ articleIds?: string[]; userFileIds?: string[] }>(request, INTERNAL_CORS_HEADERS);
	if (body instanceof Response) return body;

	const articleIds = body.articleIds?.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()) ?? [];
	const userFileIds = body.userFileIds?.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()) ?? [];

	if (articleIds.length || userFileIds.length) {
		if (articleIds.length) await enqueueArticleBatchProcess(env, articleIds);
		if (userFileIds.length) await enqueueArticleBatchProcess(env, userFileIds, USER_FILES_TABLE);
		return jsonData({ articles: articleIds.length, userFiles: userFileIds.length }, INTERNAL_CORS_HEADERS);
	}

	ctx.waitUntil(handleRetryCron(env, ctx));
	return jsonData({ queued: true }, INTERNAL_CORS_HEADERS);
}

async function handleWorkflowStream(request: Request, instanceId: string, env: Env): Promise<Response> {
	const unauth = await requireAuth(request, env);
	if (unauth) return unauth;

	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const encoder = new TextEncoder();
	const writeEvent = (data: object) => writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

	(async () => {
		try {
			for (let i = 0; i < 40; i++) {
				const instance = await env.MONITOR_WORKFLOW.get(instanceId);
				const { status, error, output } = await instance.status();
				const isTerminal = status === 'complete' || status === 'errored' || status === 'terminated';

				if (status === 'complete') {
					await writeEvent({ status: 'complete', output });
					return;
				}

				await writeEvent({ status, error });
				if (isTerminal) return;
				await sleep(3000);
			}
			await writeEvent({ status: 'timeout' });
		} catch (err) {
			await writeEvent({ status: 'error', error: String(err) });
		} finally {
			await writer.close();
		}
	})();

	return new Response(readable, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no',
		},
	});
}

function routePrefixGet(request: Request, pathname: string, env: Env): Response | Promise<Response> | null {
	if (pathname.startsWith('/stream/')) {
		const id = pathname.slice('/stream/'.length);
		if (id) return handleWorkflowStream(request, id, env);
	}
	const id = scrapeJobId(pathname);
	if (id) return handleScrapeJobStatus(request, id, env);
	return null;
}

// Match `/prefix/...` for any method; also match exact `/prefix` for OPTIONS
// so CORS preflights to the root URL still hit the handler.
function matchesEndpoint(pathname: string, method: string, ...prefixes: string[]): boolean {
	for (const p of prefixes) {
		if (pathname.startsWith(`${p}/`)) return true;
		if (method === 'OPTIONS' && pathname === p) return true;
	}
	return false;
}

export function routeRequest(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
	const { pathname } = new URL(request.url);
	const { method } = request;

	if (pathname === '/health') return health();
	if (matchesEndpoint(pathname, method, '/media/external')) {
		return handleProxy(request, env, ctx);
	}
	if (matchesEndpoint(pathname, method, '/media/asset')) {
		return handleR2Asset(request, env, ctx);
	}

	if (method === 'OPTIONS') {
		const handler = OPTIONS_ROUTES[pathname];
		if (handler) return handler(request, env, ctx);

		const id = scrapeJobId(pathname);
		if (id) return handleScrapeJobStatus(request, id, env);
	}

	if (method === 'POST') {
		const handler = POST_ROUTES[pathname];
		if (handler) return handler(request, env, ctx);
	}

	if (method === 'GET') {
		const response = routePrefixGet(request, pathname, env);
		if (response) return response;
	}

	return new Response(HELP_TEXT, { headers: { 'Content-Type': 'text/plain' } });
}
