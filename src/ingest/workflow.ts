import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { generateArticleEmbedding, prepareArticleTextForEmbedding } from '@core-ai/embedding';
import {
	getIncompleteWorkflowTargetIds,
	getUserFileWorkflowInstanceId,
	type InsertArticleData,
	insertArticleDataToArticle,
	insertFinalSourceArticle,
	loadArticleForProcessing,
	patchUserFileWorkflowMetadata,
	updateArticleAfterProcessing,
} from '@core-shared/article-store';
import type { PaperMetadata } from '@core-shared/platform-metadata';
import type { Article } from '@core-shared/types';
import { normalizeArticleEntityUpdatePayload } from '@entities/normalize';
import { syncArticleEntities } from '@entities/sync';
import { Client } from 'pg';
import {
	buildProcessorUpdatePayload,
	getArticlePlatformForArticle,
	type PlatformWorkflowData,
	type ProcessorResult,
} from './domain/processors';
import { stagePaperEnrichment, syncPaperGraphForEnrichment } from './platforms/paper/semanticscholar';
import { type PdfTextTempResult, pdfTextExtractionMetadata, readPdfTextTemp, stagePdfTextExtraction } from './platforms/pdf';

type StoredWorkflowTarget = { kind: 'article'; articleId: string } | { kind: 'userFile'; userFileId: string };

export type WorkflowTarget = StoredWorkflowTarget | { kind: 'source'; sourceArticle: { url: string; r2Key: string } };

export interface SourceArticleDraft {
	article: InsertArticleData;
	attachments?: unknown[];
}

const ACTIVE_WORKFLOW_STATUSES = new Set(['queued', 'running', 'paused', 'waiting', 'waitingForPause']);
const RETRY_BATCH_SIZE = 100;
const SOURCE_ARTICLE_DRAFT_PREFIX = 'tmp/workflow/source-articles/';
const SOURCE_ARTICLE_DRAFT_CONTENT_TYPE = 'application/json; charset=utf-8';
const WORKFLOW_ID_MAX_LENGTH = 100;

async function startStoredWorkflowBatch(env: Env, targets: StoredWorkflowTarget[]): Promise<number> {
	if (!targets.length) return 0;
	const descriptors = targets.map(storedWorkflowTarget);
	const created = await env.MONITOR_WORKFLOW.createBatch(
		descriptors.map(({ workflowId, workflowTarget }) => ({ id: workflowId, params: { target: workflowTarget } })),
	);
	const createdIds = new Set(created.map((instance) => instance.id));
	const retryTargets: typeof descriptors = [];
	let active = 0;
	for (const target of descriptors) {
		if (createdIds.has(target.workflowId)) continue;
		const existing = await getMonitorWorkflowStatus(env, target.workflowId);
		if (ACTIVE_WORKFLOW_STATUSES.has(existing.status)) active++;
		else retryTargets.push(target);
	}
	if (!retryTargets.length) return created.length + active;
	const retried = await env.MONITOR_WORKFLOW.createBatch(
		retryTargets.map(({ workflowId, workflowTarget }) => ({
			id: retryWorkflowId(workflowId),
			params: { target: workflowTarget },
		})),
	);
	return created.length + active + retried.length;
}

export async function handleRetryCron(env: Env): Promise<void> {
	console.info({ tag: 'RETRY', msg: 'start' });
	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
	const { articleIds, userFileIds } = await getIncompleteWorkflowTargetIds(db, since);
	const total = articleIds.length + userFileIds.length;

	if (!total) return console.info({ tag: 'RETRY', msg: 'No incomplete articles' });
	let started = 0;
	for (let i = 0; i < articleIds.length; i += RETRY_BATCH_SIZE) {
		started += await startStoredWorkflowBatch(
			env,
			articleIds.slice(i, i + RETRY_BATCH_SIZE).map((articleId) => ({ kind: 'article', articleId })),
		);
	}
	for (let i = 0; i < userFileIds.length; i += RETRY_BATCH_SIZE) {
		started += await startStoredWorkflowBatch(
			env,
			userFileIds.slice(i, i + RETRY_BATCH_SIZE).map((userFileId) => ({ kind: 'userFile', userFileId })),
		);
	}
	console.info({
		tag: 'RETRY',
		msg: 'Started workflows for retry',
		articles: articleIds.length,
		userFiles: userFileIds.length,
		started,
		batches: Math.ceil(articleIds.length / RETRY_BATCH_SIZE) + Math.ceil(userFileIds.length / RETRY_BATCH_SIZE),
	});
}

export async function startArticleWorkflow(env: Env, articleId: string): Promise<string> {
	return startStoredWorkflow(env, { kind: 'article', articleId });
}

async function startStoredWorkflow(env: Env, target: StoredWorkflowTarget): Promise<string> {
	const { workflowId, workflowTarget } = storedWorkflowTarget(target);
	const created = await env.MONITOR_WORKFLOW.createBatch([{ id: workflowId, params: { target: workflowTarget } }]);
	if (created[0]) return created[0].id;

	const existing = await getMonitorWorkflowStatus(env, workflowId);
	if (ACTIVE_WORKFLOW_STATUSES.has(existing.status)) return existing.id;

	const retried = await env.MONITOR_WORKFLOW.createBatch([{ id: retryWorkflowId(workflowId), params: { target: workflowTarget } }]);
	if (!retried[0]) throw new Error(`Failed to create stored workflow: ${workflowId}`);
	return retried[0].id;
}

export async function startSourceArticleWorkflow(env: Env, draft: SourceArticleDraft): Promise<void> {
	const sourceArticle = { url: draft.article.url, r2Key: `${SOURCE_ARTICLE_DRAFT_PREFIX}${crypto.randomUUID()}.json` };
	const workflowTarget: WorkflowTarget = { kind: 'source', sourceArticle };
	await env.R2.put(sourceArticle.r2Key, JSON.stringify(draft), { httpMetadata: { contentType: SOURCE_ARTICLE_DRAFT_CONTENT_TYPE } });

	let keepDraft = false;
	let cleanupReason = 'workflow create failed';
	let cleanupWorkflowId: string | undefined;
	try {
		const workflowId = await sourceArticleWorkflowId(sourceArticle.url);
		const created = await env.MONITOR_WORKFLOW.createBatch([{ id: workflowId, params: { target: workflowTarget } }]);
		if (created.length) {
			keepDraft = true;
			return;
		}

		const existing = await getMonitorWorkflowStatus(env, workflowId);
		if (existing.status === 'complete' || ACTIVE_WORKFLOW_STATUSES.has(existing.status)) {
			cleanupReason = 'workflow already exists';
			cleanupWorkflowId = existing.id;
			return;
		}

		const retryId = retryWorkflowId(workflowId);
		const retried = await env.MONITOR_WORKFLOW.createBatch([{ id: retryId, params: { target: workflowTarget } }]);
		if (!retried.length) throw new Error(`Failed to create source workflow ${retryId}`);
		keepDraft = true;
	} finally {
		if (!keepDraft) {
			await env.R2.delete(sourceArticle.r2Key).catch((error) =>
				console.warn({
					tag: 'SOURCE-WORKFLOW',
					msg: 'Failed to cleanup source article draft',
					reason: cleanupReason,
					workflowId: cleanupWorkflowId,
					sourceUrl: sourceArticle.url,
					error: String(error),
				}),
			);
		}
	}
}

function workflowIdPart(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
}

function storedWorkflowTarget(target: StoredWorkflowTarget): {
	workflowId: string;
	workflowTarget: WorkflowTarget;
} {
	const id = target.kind === 'article' ? target.articleId : target.userFileId;
	const table = target.kind === 'article' ? 'articles' : 'user_files';
	return { workflowId: ['article', workflowIdPart(table), workflowIdPart(id)].join('-'), workflowTarget: target };
}

function retryWorkflowId(workflowId: string): string {
	return `${workflowId.slice(0, WORKFLOW_ID_MAX_LENGTH - 37)}-${crypto.randomUUID()}`;
}

async function sourceArticleWorkflowId(url: string): Promise<string> {
	const bytes = new TextEncoder().encode(url);
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	const hash = [...new Uint8Array(digest)]
		.slice(0, 16)
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
	return `source-article-${hash}`;
}

export async function createUserFileWorkflow(env: Env, userFileId: string, db?: Client): Promise<string> {
	const client = db ?? new Client({ connectionString: env.HYPERDRIVE.connectionString });
	if (!db) await client.connect();
	const storedInstanceId = await getUserFileWorkflowInstanceId(client, userFileId);
	if (storedInstanceId) {
		const stored = await getMonitorWorkflowStatus(env, storedInstanceId);
		if (ACTIVE_WORKFLOW_STATUSES.has(stored.status)) return stored.id;
	}

	const instanceId = await startStoredWorkflow(env, { kind: 'userFile', userFileId });
	await patchUserFileWorkflowMetadata(client, userFileId, {
		monitor_instance_id: instanceId,
		monitor_status: 'running',
		monitor_started_at: new Date().toISOString(),
	});
	return instanceId;
}

async function getMonitorWorkflowStatus(env: Env, workflowId: string): Promise<{ id: string; status: string }> {
	try {
		const instance = await env.MONITOR_WORKFLOW.get(workflowId);
		const status = await instance.status();
		return { id: instance.id, status: status.status };
	} catch {
		// Missing or expired instances are not live; callers may create a retry instance.
		return { id: workflowId, status: 'unknown' };
	}
}

type WorkflowRunContext = {
	target: WorkflowTarget;
	table: 'articles' | 'user_files';
	rowId: string | null;
	userFileId: string | null;
	readSourceDraft(): Promise<SourceArticleDraft>;
};
type WorkflowPersistenceInput = {
	article: Article;
	result: ProcessorResult;
	embedding: number[] | null;
	pdfTextTemp: PdfTextTempResult | null;
	platformWorkflowData: PlatformWorkflowData | null;
	paperEnrichment: PaperMetadata | null;
};

function createWorkflowRunContext(env: Env, target: WorkflowTarget): WorkflowRunContext {
	const readSourceDraft = async () => {
		if (target.kind !== 'source') throw new Error('Source draft requested for row workflow target');
		const obj = await env.R2.get(target.sourceArticle.r2Key);
		if (!obj) throw new Error(`source article draft missing: ${target.sourceArticle.r2Key}`);
		return obj.json<SourceArticleDraft>();
	};

	return {
		target,
		table: target.kind === 'userFile' ? 'user_files' : 'articles',
		rowId: target.kind === 'article' ? target.articleId : target.kind === 'userFile' ? target.userFileId : null,
		userFileId: target.kind === 'userFile' ? target.userFileId : null,
		readSourceDraft,
	};
}

async function loadFullTargetArticle(env: Env, context: WorkflowRunContext, pdfTextTemp: PdfTextTempResult | null): Promise<Article> {
	let article: Article;
	if (context.target.kind === 'source') {
		article = insertArticleDataToArticle((await context.readSourceDraft()).article);
	} else {
		if (!context.rowId) throw new Error('Stored workflow target is missing row id');
		article = await loadArticleForProcessing(env, context.table, context.rowId);
	}
	const pdfText = await readPdfTextTemp(env, pdfTextTemp);
	return pdfText === null ? article : { ...article, content: pdfText };
}

async function persistSourceTarget(env: Env, context: WorkflowRunContext, input: WorkflowPersistenceInput): Promise<string> {
	const draft = await context.readSourceDraft();
	const fullArticle = insertArticleDataToArticle(draft.article);
	const articleForInsert = { ...draft.article, ogImageUrl: null };
	const updatePayload: Record<string, unknown> = {
		...buildProcessorUpdatePayload(
			fullArticle,
			input.result,
			input.embedding,
			input.paperEnrichment ? { type: 'paper', data: input.paperEnrichment } : undefined,
		),
		og_image_url: null,
	};
	const platformMetadata = updatePayload.platform_metadata ?? articleForInsert.platformMetadata;
	const entities = normalizeArticleEntityUpdatePayload(updatePayload, articleForInsert.source, platformMetadata);
	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	await db.query('BEGIN');
	try {
		const articleId = await insertFinalSourceArticle(db, articleForInsert, updatePayload);
		if (entities) await syncArticleEntities(db, articleId, entities, articleForInsert.source, platformMetadata);
		await getArticlePlatformForArticle(fullArticle).persistWorkflowData?.(db, {
			articleId,
			data: input.platformWorkflowData,
			attachments: draft.attachments,
		});
		await db.query('COMMIT');
		return articleId;
	} catch (error) {
		await db
			.query('ROLLBACK')
			.catch((rollbackError) => console.error({ tag: 'DB', msg: 'source article rollback failed', error: String(rollbackError) }));
		throw error;
	}
}

async function persistStoredTarget(env: Env, context: WorkflowRunContext, input: WorkflowPersistenceInput): Promise<string> {
	if (!context.rowId) throw new Error('Stored workflow target is missing row id');
	const extractedPdfText = await readPdfTextTemp(env, input.pdfTextTemp);
	const finalResult: ProcessorResult = {
		...input.result,
		updateData: {
			...input.result.updateData,
			...(extractedPdfText !== null ? { content: extractedPdfText } : {}),
		},
	};
	const metadataPatch = {
		...(pdfTextExtractionMetadata(input.pdfTextTemp) ?? {}),
		...(input.paperEnrichment ? { type: 'paper', data: input.paperEnrichment } : {}),
	};
	const updatePayload = buildProcessorUpdatePayload(
		input.article,
		finalResult,
		input.embedding,
		Object.keys(metadataPatch).length ? metadataPatch : undefined,
	);
	const platformMetadata = updatePayload.platform_metadata ?? input.article.platform_metadata;
	const entities = normalizeArticleEntityUpdatePayload(updatePayload, input.article.source, platformMetadata);

	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	await db.query('BEGIN');
	try {
		await updateArticleAfterProcessing(db, context.table, context.rowId, updatePayload);
		if (context.userFileId)
			await patchUserFileWorkflowMetadata(db, context.userFileId, {
				monitor_status: 'complete',
				monitor_completed_at: new Date().toISOString(),
				article_id: context.rowId,
			});
		if (!context.userFileId && entities) await syncArticleEntities(db, context.rowId, entities, input.article.source, platformMetadata);
		await getArticlePlatformForArticle(input.article).persistWorkflowData?.(db, {
			articleId: context.rowId,
			data: input.platformWorkflowData,
		});
		await db.query('COMMIT');
		return context.rowId;
	} catch (error) {
		await db
			.query('ROLLBACK')
			.catch((rollbackError) => console.error({ tag: 'DB', msg: 'row workflow rollback failed', error: String(rollbackError) }));
		throw error;
	}
}

export class NewsenceMonitorWorkflow extends WorkflowEntrypoint<Env, { target: WorkflowTarget }> {
	async run(event: WorkflowEvent<{ target: WorkflowTarget }>, step: WorkflowStep) {
		const context = createWorkflowRunContext(this.env, event.payload.target);
		try {
			const article = await step.do(
				context.target.kind === 'source' ? 'load-source-article-shell' : 'fetch-article-shell',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				async () => {
					if (context.target.kind === 'source')
						return { ...insertArticleDataToArticle((await context.readSourceDraft()).article), content: null };
					if (!context.rowId) throw new Error('Stored workflow target is missing row id');
					return loadArticleForProcessing(this.env, context.table, context.rowId, true);
				},
			);
			const sourceType = article.source_type ?? 'default';
			const platform = getArticlePlatformForArticle(article);
			const logContext =
				context.target.kind === 'source' ? { url: article.url, table: context.table } : { article_id: context.rowId, table: context.table };

			console.info({ tag: 'WORKFLOW', msg: 'Starting', sourceType, ...logContext });

			const pdfTextTemp = await stagePdfTextExtraction(this.env, step, {
				articleId: context.userFileId,
				hasContent: 'has_content' in article && !!article.has_content,
				storageKey: article.storage_key,
				originType: article.origin_type,
				fileType: article.file_type,
				tempId: workflowIdPart(event.instanceId),
			});

			const paperEnrichment = await stagePaperEnrichment(this.env, step, article, {
				hasStagedText: !!pdfTextTemp?.textStorageKey,
				loadContent: async () => (await loadFullTargetArticle(this.env, context, pdfTextTemp)).content,
			});

			const processorResult = await step.do(
				'ai-analysis',
				{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '180 seconds' },
				async () => platform.process(await loadFullTargetArticle(this.env, context, pdfTextTemp), { env: this.env, table: context.table }),
			);

			const embedding = await step.do(
				'generate-embedding',
				{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
				async () => {
					const article = await loadFullTargetArticle(this.env, context, pdfTextTemp);
					const text = prepareArticleTextForEmbedding({
						title: article.title,
						summary: processorResult.updateData.summary ?? article.summary,
						content: processorResult.updateData.content ?? article.content,
						tags: processorResult.updateData.tags ?? article.tags,
						keywords: processorResult.updateData.keywords ?? article.keywords,
					});
					return text && this.env.AI ? generateArticleEmbedding(text, this.env.AI, this.env.AI_GATEWAY_NAME) : null;
				},
			);

			const platformWorkflowData = platform.prepareWorkflowData
				? await step.do(
						'prepare-platform-workflow-data',
						{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
						async () => {
							const attachments = context.target.kind === 'source' ? (await context.readSourceDraft()).attachments : undefined;
							return platform.prepareWorkflowData?.(article, { env: this.env, table: context.table }, attachments) ?? null;
						},
					)
				: null;
			const articleId = await step.do(
				context.target.kind === 'source' ? 'insert-final-article' : 'update-db',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() => {
					const input = {
						article,
						result: processorResult,
						embedding,
						pdfTextTemp,
						platformWorkflowData,
						paperEnrichment,
					};
					return context.target.kind === 'source'
						? persistSourceTarget(this.env, context, input)
						: persistStoredTarget(this.env, context, input);
				},
			);

			await syncPaperGraphForEnrichment(this.env, step, articleId, paperEnrichment);

			if (pdfTextTemp?.textStorageKey || context.target.kind === 'source') {
				await step.do('cleanup-workflow-temp-objects', { retries: { limit: 1, delay: '5 seconds' }, timeout: '20 seconds' }, async () => {
					const keys = [
						...(pdfTextTemp?.textStorageKey ? [pdfTextTemp.textStorageKey] : []),
						...(context.target.kind === 'source' ? [context.target.sourceArticle.r2Key] : []),
					];
					try {
						await this.env.R2.delete(keys);
					} catch (error) {
						console.warn({ tag: 'WORKFLOW', msg: 'Temp object cleanup failed', keys, error: String(error) });
					}
				});
			}

			console.info({ tag: 'WORKFLOW', msg: 'Completed', article_id: articleId, ...logContext });
			return { success: true, article_id: articleId };
		} catch (error) {
			if (context.userFileId) {
				const failedUserFileId = context.userFileId;
				try {
					await step.do(
						'record-user-file-workflow-failed',
						{ retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '15 seconds' },
						async () => {
							const db = new Client({ connectionString: this.env.HYPERDRIVE.connectionString });
							await db.connect();
							await patchUserFileWorkflowMetadata(db, failedUserFileId, {
								monitor_status: 'failed',
								monitor_failed_at: new Date().toISOString(),
								error: String(error).slice(0, 500),
							});
						},
					);
				} catch (metadataError) {
					console.warn({
						tag: 'WORKFLOW',
						msg: 'Failed to record user_file workflow failure',
						article_id: failedUserFileId,
						error: String(metadataError),
					});
				}
			}
			throw error;
		}
	}
}
