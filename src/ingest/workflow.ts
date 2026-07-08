import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { generateArticleEmbedding, prepareArticleTextForEmbedding } from '@core-ai/embedding';
import type { Article, PaperMetadata, PlatformMetadata, YoutubeTranscript } from '@core-shared/types';
import { normalizeArticleEntityUpdatePayload } from '@entities/normalize';
import { syncArticleEntities } from '@entities/sync';
import { insertFinalSourceArticle, loadArticleForProcessing, updateArticleAfterProcessing } from '@ingest/domain/article-store';
import { Client } from 'pg';
import { generateArticleAnalysis, mergeArticleAnalysis, type ProcessorResult } from './domain/ai-utils';
import { processHackerNewsArticle } from './platforms/hackernews';
import { stagePaperEnrichment, syncPaperGraphForEnrichment } from './platforms/paper';
import { pdfTextExtractionMetadata, readExtractedPdfText, stagePdfTextExtraction } from './platforms/pdf';
import { processTwitterArticle } from './platforms/twitter';
import { persistYouTubeWorkflowData, prepareYouTubeHighlights } from './platforms/youtube';

type ArticleProcessor = (article: Article, env: CoreEnv) => Promise<ProcessorResult>;

const articlePlatforms: Partial<Record<string, ArticleProcessor>> = {
	hackernews: processHackerNewsArticle,
	twitter: processTwitterArticle,
};

function sourceRecordToArticle(data: SourceArticleRecord): Article {
	return {
		id: data.url,
		title: data.title,
		title_cn: null,
		summary: data.summary || null,
		summary_cn: null,
		content: data.content,
		content_cn: null,
		url: data.url,
		source: data.source,
		published_date: typeof data.publishedDate === 'string' ? data.publishedDate : data.publishedDate.toISOString(),
		tags: data.tags ?? [],
		keywords: data.keywords ?? [],
		source_type: data.sourceType,
		platform_metadata: data.platformMetadata as Article['platform_metadata'],
	};
}

function buildProcessorUpdatePayload(
	article: Article,
	result: ProcessorResult,
	embedding?: number[] | null,
	metadataPatch?: Record<string, unknown>,
): Record<string, unknown> {
	const updatePayload: Record<string, unknown> = { ...result.updateData };
	const category = result.classificationCategory;
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

type StoredWorkflowTarget = { kind: 'stored'; table: 'articles' | 'user_files'; rowId: string };

type WorkflowTarget = StoredWorkflowTarget | { kind: 'source'; draft: SourceArticleDraft };
type SourceArticleRecord = Parameters<typeof insertFinalSourceArticle>[1];

interface SourceArticleDraft {
	article: SourceArticleRecord;
	youtubeTranscript?: YoutubeTranscript;
}

type PdfTextArtifact = Awaited<ReturnType<typeof stagePdfTextExtraction>>;

const ACTIVE_WORKFLOW_STATUSES = new Set(['queued', 'running', 'paused', 'waiting', 'waitingForPause']);
const TERMINAL_WORKFLOW_STATUSES = new Set(['complete', 'errored', 'terminated']);
const WORKFLOW_STREAM_INTERVAL_MS = 3000;

export async function enqueueProcessing(
	env: CoreEnv,
	target: StoredWorkflowTarget | { kind: 'source'; draft: SourceArticleDraft },
): Promise<string> {
	const workflowTarget: WorkflowTarget = target.kind === 'source' ? { kind: 'source', draft: target.draft } : target;
	const workflowId = target.kind === 'source' ? await sourceArticleWorkflowId(target.draft.article.url) : storedWorkflowId(target);
	const [created] = await env.MONITOR_WORKFLOW.createBatch([{ id: workflowId, params: { target: workflowTarget } }]);
	if (created) return created.id;

	const instance = await env.MONITOR_WORKFLOW.get(workflowId);
	const { status } = await instance.status();
	if (ACTIVE_WORKFLOW_STATUSES.has(status) || (workflowTarget.kind === 'source' && status === 'complete')) return instance.id;

	await instance.restart();
	return instance.id;
}

function workflowIdPart(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
}

function storedWorkflowId(target: StoredWorkflowTarget): string {
	return ['article', workflowIdPart(target.table), workflowIdPart(target.rowId)].join('-');
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

export function streamWorkflowStatus(env: CoreEnv, workflowId: string): Response {
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
	youtubeHighlights: Awaited<ReturnType<typeof prepareYouTubeHighlights>>;
	paperEnrichment: PaperMetadata | null;
};

async function loadFullTargetArticle(env: CoreEnv, target: WorkflowTarget, pdfTextArtifact: PdfTextArtifact): Promise<Article> {
	let article: Article;
	if (target.kind === 'source') {
		article = sourceRecordToArticle(target.draft.article);
	} else {
		article = await loadArticleForProcessing(env, target.table, target.rowId);
	}
	const extractedPdfText = await readExtractedPdfText(env, pdfTextArtifact);
	return extractedPdfText === null ? article : { ...article, content: extractedPdfText };
}

async function persistSourceTarget(db: Client, draft: SourceArticleDraft, input: WorkflowPersistenceInput): Promise<string> {
	const fullArticle = sourceRecordToArticle(draft.article);
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

	await updateArticleAfterProcessing(db, target.table, target.rowId, updatePayload);
	if (target.table === 'articles' && entities)
		await syncArticleEntities(db, target.rowId, entities, input.article.source, platformMetadata);
	return target.rowId;
}

async function persistWorkflowTarget(env: CoreEnv, target: WorkflowTarget, input: WorkflowPersistenceInput): Promise<string> {
	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	await db.query('BEGIN');
	try {
		const articleId =
			target.kind === 'source' ? await persistSourceTarget(db, target.draft, input) : await persistStoredTarget(db, target, input);
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

export class NewsenceMonitorWorkflow extends WorkflowEntrypoint<CoreEnv, { target: WorkflowTarget }> {
	async run(event: WorkflowEvent<{ target: WorkflowTarget }>, step: WorkflowStep) {
		const target = event.payload.target;
		const article = await step.do(
			target.kind === 'source' ? 'load-source-article-shell' : 'fetch-article-shell',
			{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => {
				if (target.kind === 'source') return { ...sourceRecordToArticle(target.draft.article), content: null };
				return loadArticleForProcessing(this.env, target.table, target.rowId, true);
			},
		);
		const metadataType = article.platform_metadata?.type;
		const sourceType =
			metadataType && metadataType !== 'pdf' && metadataType !== 'paper' ? metadataType : (article.source_type ?? 'default');
		const platform = articlePlatforms[sourceType];
		const logContext =
			target.kind === 'source' ? { url: article.url, table: 'articles' } : { article_id: target.rowId, table: target.table };

		console.info({ tag: 'WORKFLOW', msg: 'Starting', sourceType, ...logContext });

		const pdfTextArtifact = await stagePdfTextExtraction(this.env, step, {
			articleId: target.kind === 'stored' && target.table === 'user_files' ? target.rowId : null,
			hasContent: 'has_content' in article && !!article.has_content,
			sourceStorageKey: article.storage_key,
			fileType: article.file_type,
			workflowRunId: workflowIdPart(event.instanceId),
		});

		const paperEnrichment = await stagePaperEnrichment(this.env, step, article, {
			hasStagedText: !!pdfTextArtifact?.extractedTextKey,
			loadContent: async () => (await loadFullTargetArticle(this.env, target, pdfTextArtifact)).content,
		});

		const processorResult = await step.do(
			'ai-analysis',
			{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '180 seconds' },
			async () => {
				const article = await loadFullTargetArticle(this.env, target, pdfTextArtifact);
				if (platform) return platform(article, this.env);
				return mergeArticleAnalysis(article, await generateArticleAnalysis(article, this.env));
			},
		);

		const embedding = await step.do(
			'generate-embedding',
			{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
			async () => {
				const article = await loadFullTargetArticle(this.env, target, pdfTextArtifact);
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

		const youtubeTranscript = sourceType === 'youtube' && target.kind === 'source' ? target.draft.youtubeTranscript : undefined;
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
					article: pdfTextArtifact?.extractedTextKey ? await loadFullTargetArticle(this.env, target, pdfTextArtifact) : article,
					result: processorResult,
					embedding,
					pdfTextArtifact,
					youtubeTranscript,
					youtubeHighlights,
					paperEnrichment,
				}),
		);

		await syncPaperGraphForEnrichment(this.env, step, articleId, paperEnrichment);

		const scratchKeys = [pdfTextArtifact?.extractedTextKey].filter((key): key is string => !!key);
		if (scratchKeys.length) {
			await step.do('cleanup-workflow-scratch-objects', { retries: { limit: 1, delay: '5 seconds' }, timeout: '20 seconds' }, async () => {
				try {
					await this.env.R2.delete(scratchKeys);
				} catch (error) {
					console.warn({ tag: 'WORKFLOW', msg: 'Workflow scratch cleanup failed', keys: scratchKeys, error: String(error) });
				}
			});
		}

		console.info({ tag: 'WORKFLOW', msg: 'Completed', article_id: articleId, ...logContext });
		return { success: true, article_id: articleId };
	}
}
