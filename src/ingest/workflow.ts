import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { generateArticleEmbedding, prepareArticleTextForEmbedding } from '@core-ai/embedding';
import type { ArticleCategory, PaperMetadata, PlatformMetadata } from '@core-shared/platform-metadata';
import type { Article, YoutubeTranscript } from '@core-shared/types';
import { normalizeArticleEntityUpdatePayload } from '@entities/normalize';
import { syncArticleEntities } from '@entities/sync';
import {
	getIncompleteWorkflowTargetIds,
	getUserFileWorkflowInstanceId,
	insertFinalSourceArticle,
	loadArticleForProcessing,
	type PreparedArticleRecord,
	patchUserFileWorkflowMetadata,
	preparedArticleToArticle,
	updateArticleAfterProcessing,
} from '@ingest/domain/article-store';
import { Client } from 'pg';
import { generateArticleAnalysis, mergeArticleAnalysis, type ProcessorResult } from './domain/ai-utils';
import { processHackerNewsArticle } from './platforms/hackernews/scraper';
import { stagePaperEnrichment, syncPaperGraphForEnrichment } from './platforms/paper/semanticscholar';
import { pdfTextExtractionMetadata, readExtractedPdfText, stagePdfTextExtraction } from './platforms/pdf';
import { processTwitterArticle } from './platforms/twitter/processor';
import { persistYouTubeWorkflowData, prepareYouTubeHighlights } from './platforms/youtube/transcripts';

type ArticleProcessor = (article: Article, env: Env) => Promise<ProcessorResult>;

async function processDefaultArticle(article: Article, env: Env): Promise<ProcessorResult> {
	const analysis = await generateArticleAnalysis(article, env);
	return mergeArticleAnalysis(article, analysis);
}

const articlePlatforms: Record<string, ArticleProcessor> = {
	hackernews: processHackerNewsArticle,
	rss: processDefaultArticle,
	twitter: processTwitterArticle,
	web: processDefaultArticle,
	youtube: processDefaultArticle,
	default: processDefaultArticle,
};

const CONTENT_STAGE_METADATA_TYPES = new Set(['pdf', 'paper']);

function platformIdentity(article: Article): string {
	const metadataType = article.platform_metadata?.type;
	return metadataType && !CONTENT_STAGE_METADATA_TYPES.has(metadataType) ? metadataType : (article.source_type ?? 'default');
}

const ARTICLE_CATEGORIES = new Set<ArticleCategory>(['AI', 'Tech', 'Finance', 'Research', 'Business', 'Other']);

function buildProcessorUpdatePayload(
	article: Article,
	result: ProcessorResult,
	embedding?: number[] | null,
	metadataPatch?: Record<string, unknown>,
): Record<string, unknown> {
	const updatePayload: Record<string, unknown> = { ...result.updateData };
	const category =
		result.classificationCategory ??
		(Array.isArray(updatePayload.tags)
			? updatePayload.tags.find((tag): tag is ArticleCategory => typeof tag === 'string' && ARTICLE_CATEGORIES.has(tag as ArticleCategory))
			: null);
	const hasEnrichments = !!result.enrichments && Object.keys(result.enrichments).length > 0;
	let mergedMetadata: PlatformMetadata | null = article.platform_metadata ?? null;
	if (hasEnrichments && mergedMetadata) {
		mergedMetadata = {
			...mergedMetadata,
			enrichments: { ...(mergedMetadata.enrichments || {}), ...result.enrichments, processedAt: new Date().toISOString() },
		};
	}
	if (category) {
		const base = mergedMetadata ??
			article.platform_metadata ?? { type: 'default' as const, fetchedAt: new Date().toISOString(), data: null };
		mergedMetadata = {
			...base,
			classification: {
				...(base.classification ?? {}),
				category,
				classifiedAt: new Date().toISOString(),
			},
		};
	}
	if (metadataPatch) updatePayload.platform_metadata = { ...(mergedMetadata ?? article.platform_metadata ?? {}), ...metadataPatch };
	else if (mergedMetadata) updatePayload.platform_metadata = mergedMetadata;
	if (embedding?.length) updatePayload.embedding = `[${embedding.join(',')}]`;
	return updatePayload;
}

type StoredWorkflowTarget =
	| { kind: 'article'; articleId: string }
	| { kind: 'userFile'; userFileId: string; youtubeTranscript?: YoutubeTranscript };
type UserFileWorkflowTarget = Extract<StoredWorkflowTarget, { kind: 'userFile' }>;

export type WorkflowTarget = StoredWorkflowTarget | { kind: 'source'; sourceDraftKey: string };

interface SourceArticleDraft {
	article: PreparedArticleRecord;
	youtubeTranscript?: YoutubeTranscript;
}

type ProcessingTarget = StoredWorkflowTarget | { kind: 'source'; draft: SourceArticleDraft };
type PdfTextArtifact = Awaited<ReturnType<typeof stagePdfTextExtraction>>;
type YouTubeHighlights = Awaited<ReturnType<typeof prepareYouTubeHighlights>>;

const ACTIVE_WORKFLOW_STATUSES = new Set(['queued', 'running', 'paused', 'waiting', 'waitingForPause']);
const TERMINAL_WORKFLOW_STATUSES = new Set(['complete', 'errored', 'error', 'terminated', 'timeout']);
const RETRY_BATCH_SIZE = 100;
const WORKFLOW_STREAM_INTERVAL_MS = 3000;
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

export async function enqueueProcessing(env: Env, target: ProcessingTarget, options: { db?: Client } = {}): Promise<string> {
	if (target.kind === 'source') return enqueueSourceArticleWorkflow(env, target.draft);
	if (target.kind === 'article') return enqueueStoredWorkflow(env, target);
	return enqueueUserFileWorkflow(env, target, options.db);
}

async function enqueueStoredWorkflow(env: Env, target: StoredWorkflowTarget): Promise<string> {
	const { workflowId, workflowTarget } = storedWorkflowTarget(target);
	const created = await env.MONITOR_WORKFLOW.createBatch([{ id: workflowId, params: { target: workflowTarget } }]);
	if (created[0]) return created[0].id;

	const existing = await getMonitorWorkflowStatus(env, workflowId);
	if (ACTIVE_WORKFLOW_STATUSES.has(existing.status)) return existing.id;

	const retried = await env.MONITOR_WORKFLOW.createBatch([{ id: retryWorkflowId(workflowId), params: { target: workflowTarget } }]);
	if (!retried[0]) throw new Error(`Failed to create stored workflow: ${workflowId}`);
	return retried[0].id;
}

async function enqueueSourceArticleWorkflow(env: Env, draft: SourceArticleDraft): Promise<string> {
	const sourceDraftKey = `${SOURCE_ARTICLE_DRAFT_PREFIX}${crypto.randomUUID()}.json`;
	const workflowTarget: WorkflowTarget = { kind: 'source', sourceDraftKey };
	await env.R2.put(sourceDraftKey, JSON.stringify(draft), { httpMetadata: { contentType: SOURCE_ARTICLE_DRAFT_CONTENT_TYPE } });

	let keepDraft = false;
	let cleanupReason = 'workflow create failed';
	let cleanupWorkflowId: string | undefined;
	try {
		const workflowId = await sourceArticleWorkflowId(draft.article.url);
		const created = await env.MONITOR_WORKFLOW.createBatch([{ id: workflowId, params: { target: workflowTarget } }]);
		if (created.length) {
			keepDraft = true;
			return created[0].id;
		}

		const existing = await getMonitorWorkflowStatus(env, workflowId);
		if (existing.status === 'complete' || ACTIVE_WORKFLOW_STATUSES.has(existing.status)) {
			cleanupReason = 'workflow already exists';
			cleanupWorkflowId = existing.id;
			return existing.id;
		}

		const retryId = retryWorkflowId(workflowId);
		const retried = await env.MONITOR_WORKFLOW.createBatch([{ id: retryId, params: { target: workflowTarget } }]);
		if (!retried.length) throw new Error(`Failed to create source workflow ${retryId}`);
		keepDraft = true;
		return retried[0].id;
	} finally {
		if (!keepDraft) {
			await env.R2.delete(sourceDraftKey).catch((error) =>
				console.warn({
					tag: 'SOURCE-WORKFLOW',
					msg: 'Failed to cleanup source article draft',
					reason: cleanupReason,
					workflowId: cleanupWorkflowId,
					sourceUrl: draft.article.url,
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
	const { table, rowId } = storedWorkflowRecord(target);
	return { workflowId: ['article', workflowIdPart(table), workflowIdPart(rowId)].join('-'), workflowTarget: target };
}

function storedWorkflowRecord(target: StoredWorkflowTarget) {
	return target.kind === 'article'
		? { table: 'articles' as const, rowId: target.articleId }
		: { table: 'user_files' as const, rowId: target.userFileId };
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

async function enqueueUserFileWorkflow(env: Env, target: UserFileWorkflowTarget, db?: Client): Promise<string> {
	const client = db ?? new Client({ connectionString: env.HYPERDRIVE.connectionString });
	if (!db) await client.connect();
	const storedInstanceId = await getUserFileWorkflowInstanceId(client, target.userFileId);
	if (storedInstanceId) {
		const stored = await getMonitorWorkflowStatus(env, storedInstanceId);
		if (ACTIVE_WORKFLOW_STATUSES.has(stored.status)) return stored.id;
	}

	const instanceId = await enqueueStoredWorkflow(env, target);
	await patchUserFileWorkflowMetadata(client, target.userFileId, {
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

export function streamWorkflowStatus(env: Env, workflowId: string): Response {
	const encoder = new TextEncoder();
	let cancelled = false;
	const stream = new ReadableStream({
		type: 'bytes',
		async start(controller) {
			const writeEvent = (data: { error?: unknown; output?: unknown; status: string }) => {
				if (cancelled) return false;
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
				return true;
			};
			try {
				const instance = await env.MONITOR_WORKFLOW.get(workflowId);
				while (!cancelled) {
					const { status, error, output } = await instance.status();
					const streamStatus = String(status);
					const isTerminal = TERMINAL_WORKFLOW_STATUSES.has(streamStatus);

					if (streamStatus === 'complete') {
						writeEvent({ status: 'complete', output });
						return;
					}

					if (!writeEvent({ status: streamStatus, error }) || isTerminal) return;
					await scheduler.wait(WORKFLOW_STREAM_INTERVAL_MS);
				}
			} catch (err) {
				if (!cancelled) writeEvent({ status: 'error', error: String(err) });
			} finally {
				if (!cancelled) controller.close();
			}
		},
		cancel() {
			cancelled = true;
		},
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no',
		},
	});
}

type WorkflowPersistenceInput = {
	article: Article;
	result: ProcessorResult;
	embedding: number[] | null;
	pdfTextArtifact: PdfTextArtifact;
	youtubeTranscript?: YoutubeTranscript;
	youtubeHighlights: YouTubeHighlights;
	paperEnrichment: PaperMetadata | null;
};

async function readSourceDraft(env: Env, target: WorkflowTarget): Promise<SourceArticleDraft> {
	if (target.kind !== 'source') throw new Error('Source draft requested for row workflow target');
	const obj = await env.R2.get(target.sourceDraftKey);
	if (!obj) throw new Error(`source article draft missing: ${target.sourceDraftKey}`);
	return obj.json<SourceArticleDraft>();
}

async function loadFullTargetArticle(env: Env, target: WorkflowTarget, pdfTextArtifact: PdfTextArtifact): Promise<Article> {
	let article: Article;
	if (target.kind === 'source') {
		article = preparedArticleToArticle((await readSourceDraft(env, target)).article);
	} else {
		const { table, rowId } = storedWorkflowRecord(target);
		article = await loadArticleForProcessing(env, table, rowId);
	}
	const extractedPdfText = await readExtractedPdfText(env, pdfTextArtifact);
	return extractedPdfText === null ? article : { ...article, content: extractedPdfText };
}

async function persistSourceTarget(db: Client, draft: SourceArticleDraft, input: WorkflowPersistenceInput): Promise<string> {
	const fullArticle = preparedArticleToArticle(draft.article);
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
	const articleId = await insertFinalSourceArticle(db, articleForInsert, updatePayload);
	if (entities) await syncArticleEntities(db, articleId, entities, articleForInsert.source, platformMetadata);
	return articleId;
}

async function persistStoredTarget(db: Client, target: StoredWorkflowTarget, input: WorkflowPersistenceInput): Promise<string> {
	const { table, rowId } = storedWorkflowRecord(target);
	const finalResult =
		input.pdfTextArtifact?.extractedTextKey && input.article.content
			? { ...input.result, updateData: { ...input.result.updateData, content: input.article.content } }
			: input.result;
	const metadataPatch = {
		...(pdfTextExtractionMetadata(input.pdfTextArtifact) ?? {}),
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

	await updateArticleAfterProcessing(db, table, rowId, updatePayload);
	if (target.kind === 'userFile')
		await patchUserFileWorkflowMetadata(db, target.userFileId, {
			monitor_status: 'complete',
			monitor_completed_at: new Date().toISOString(),
			article_id: rowId,
		});
	else if (entities) await syncArticleEntities(db, rowId, entities, input.article.source, platformMetadata);
	return rowId;
}

async function persistWorkflowTarget(env: Env, target: WorkflowTarget, input: WorkflowPersistenceInput): Promise<string> {
	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	await db.query('BEGIN');
	try {
		const articleId =
			target.kind === 'source'
				? await persistSourceTarget(db, await readSourceDraft(env, target), input)
				: await persistStoredTarget(db, target, input);
		await persistYouTubeWorkflowData(db, {
			transcript: input.youtubeTranscript,
			highlights: input.youtubeHighlights,
		});
		await db.query('COMMIT');
		return articleId;
	} catch (error) {
		await db
			.query('ROLLBACK')
			.catch((rollbackError) => console.error({ tag: 'DB', msg: 'workflow target rollback failed', error: String(rollbackError) }));
		throw error;
	}
}

export class NewsenceMonitorWorkflow extends WorkflowEntrypoint<Env, { target: WorkflowTarget }> {
	async run(event: WorkflowEvent<{ target: WorkflowTarget }>, step: WorkflowStep) {
		const target = event.payload.target;
		try {
			const article = await step.do(
				target.kind === 'source' ? 'load-source-article-shell' : 'fetch-article-shell',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				async () => {
					if (target.kind === 'source')
						return { ...preparedArticleToArticle((await readSourceDraft(this.env, target)).article), content: null };
					const { table, rowId } = storedWorkflowRecord(target);
					return loadArticleForProcessing(this.env, table, rowId, true);
				},
			);
			const sourceType = platformIdentity(article);
			const platform = articlePlatforms[sourceType] ?? articlePlatforms.default;
			const storedRecord = target.kind === 'source' ? null : storedWorkflowRecord(target);
			const logContext =
				storedRecord === null ? { url: article.url, table: 'articles' } : { article_id: storedRecord.rowId, table: storedRecord.table };

			console.info({ tag: 'WORKFLOW', msg: 'Starting', sourceType, ...logContext });

			const pdfTextArtifact = await stagePdfTextExtraction(this.env, step, {
				articleId: target.kind === 'userFile' ? target.userFileId : null,
				hasContent: 'has_content' in article && !!article.has_content,
				sourceStorageKey: article.storage_key,
				fileType: article.file_type,
				workflowRunId: workflowIdPart(event.instanceId),
			});
			let fullArticlePromise: Promise<Article> | null = null;
			const loadArticleWithDerivedContent = () => {
				fullArticlePromise ??= loadFullTargetArticle(this.env, target, pdfTextArtifact);
				return fullArticlePromise;
			};

			const paperEnrichment = await stagePaperEnrichment(this.env, step, article, {
				hasStagedText: !!pdfTextArtifact?.extractedTextKey,
				loadContent: async () => (await loadArticleWithDerivedContent()).content,
			});

			const processorResult = await step.do(
				'ai-analysis',
				{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '180 seconds' },
				async () => platform(await loadArticleWithDerivedContent(), this.env),
			);

			const embedding = await step.do(
				'generate-embedding',
				{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
				async () => {
					const article = await loadArticleWithDerivedContent();
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

			let youtubeTranscript: YoutubeTranscript | undefined;
			if (sourceType === 'youtube') {
				if (target.kind === 'source') {
					const draft = await readSourceDraft(this.env, target);
					youtubeTranscript = draft.youtubeTranscript;
				} else if (target.kind === 'userFile') {
					youtubeTranscript = target.youtubeTranscript;
				}
			}
			const youtubeHighlights =
				sourceType === 'youtube'
					? await step.do(
							'prepare-youtube-highlights',
							{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
							async () => prepareYouTubeHighlights(this.env, article, youtubeTranscript),
						)
					: null;
			const articleId = await step.do(
				target.kind === 'source' ? 'insert-final-article' : 'update-db',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				async () =>
					persistWorkflowTarget(this.env, target, {
						article: pdfTextArtifact?.extractedTextKey ? await loadArticleWithDerivedContent() : article,
						result: processorResult,
						embedding,
						pdfTextArtifact,
						youtubeTranscript,
						youtubeHighlights,
						paperEnrichment,
					}),
			);

			await syncPaperGraphForEnrichment(this.env, step, articleId, paperEnrichment);

			if (pdfTextArtifact?.extractedTextKey || target.kind === 'source') {
				const sourceDraftKey = target.kind === 'source' ? target.sourceDraftKey : null;
				await step.do(
					'cleanup-workflow-scratch-objects',
					{ retries: { limit: 1, delay: '5 seconds' }, timeout: '20 seconds' },
					async () => {
						const keys = [
							...(pdfTextArtifact?.extractedTextKey ? [pdfTextArtifact.extractedTextKey] : []),
							...(sourceDraftKey ? [sourceDraftKey] : []),
						];
						try {
							await this.env.R2.delete(keys);
						} catch (error) {
							console.warn({ tag: 'WORKFLOW', msg: 'Workflow scratch cleanup failed', keys, error: String(error) });
						}
					},
				);
			}

			console.info({ tag: 'WORKFLOW', msg: 'Completed', article_id: articleId, ...logContext });
			return { success: true, article_id: articleId };
		} catch (error) {
			if (target.kind === 'userFile') {
				const failedUserFileId = target.userFileId;
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
