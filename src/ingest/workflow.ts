import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { generateArticleEmbedding, prepareArticleTextForEmbedding } from '@core-ai/embedding';
import type { Article, PaperMetadata, PlatformMetadata, YoutubeTranscript } from '@core-shared/types';
import { normalizeArticleEntityUpdatePayload } from '@entities/normalize';
import {
	insertFinalSourceArticle,
	loadArticleForProcessing,
	syncArticleEntities,
	updateArticleAfterProcessing,
} from '@ingest/domain/article-store';
import { Client } from 'pg';
import { generateArticleAnalysis, mergeArticleAnalysis, type ProcessorResult } from './domain/ai-utils';
import { processHackerNewsArticle } from './platforms/hackernews';
import { stagePaperEnrichment, syncPaperGraphForEnrichment } from './platforms/paper';
import { type PdfTextArtifact, stagePdfTextExtraction } from './platforms/pdf';
import { processTwitterArticle } from './platforms/twitter';
import { persistYouTubeWorkflowData, prepareYouTubeHighlights } from './platforms/youtube';

const PDF_MIME = 'application/pdf';

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

const ACTIVE_WORKFLOW_STATUSES = new Set(['queued', 'running', 'paused', 'waiting', 'waitingForPause']);

export async function enqueueProcessing(env: CoreEnv, target: WorkflowTarget): Promise<string> {
	const workflowId = target.kind === 'source' ? await sourceArticleWorkflowId(target.draft.article.url) : storedWorkflowId(target);
	const [created] = await env.MONITOR_WORKFLOW.createBatch([{ id: workflowId, params: { target } }]);
	if (created) return created.id;

	const instance = await env.MONITOR_WORKFLOW.get(workflowId);
	const { status } = await instance.status();
	if (ACTIVE_WORKFLOW_STATUSES.has(status) || (target.kind === 'source' && status === 'complete')) return instance.id;

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

async function loadFullTargetArticle(env: CoreEnv, target: WorkflowTarget, pdfTextArtifact: PdfTextArtifact | null): Promise<Article> {
	let article: Article;
	if (target.kind === 'source') {
		article = sourceRecordToArticle(target.draft.article);
	} else {
		article = await loadArticleForProcessing(env, target.table, target.rowId);
	}
	const extractedPdfText = pdfTextArtifact?.text?.trim() || null;
	return extractedPdfText === null ? article : { ...article, content: extractedPdfText };
}

async function persistWorkflowTarget(
	env: CoreEnv,
	target: WorkflowTarget,
	article: Article,
	result: ProcessorResult,
	embedding: number[] | null,
	pdfTextArtifact: PdfTextArtifact | null,
	paperEnrichment: PaperMetadata | null,
	youtubeTranscript: YoutubeTranscript | undefined,
	youtubeHighlights: Awaited<ReturnType<typeof prepareYouTubeHighlights>>,
): Promise<string> {
	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	await db.query('BEGIN');
	try {
		let articleId: string;
		if (target.kind === 'source') {
			const fullArticle = sourceRecordToArticle(target.draft.article);
			const updatePayload: Record<string, unknown> = {
				...buildProcessorUpdatePayload(
					fullArticle,
					result,
					embedding,
					paperEnrichment ? { type: 'paper', data: paperEnrichment } : undefined,
				),
			};
			const platformMetadata = updatePayload.platform_metadata ?? target.draft.article.platformMetadata;
			const entities = normalizeArticleEntityUpdatePayload(updatePayload, target.draft.article.source, platformMetadata);
			articleId = await insertFinalSourceArticle(db, target.draft.article, updatePayload);
			if (entities) await syncArticleEntities(db, articleId, entities, target.draft.article.source, platformMetadata);
		} else {
			const finalResult =
				pdfTextArtifact?.text && article.content ? { ...result, updateData: { ...result.updateData, content: article.content } } : result;
			const pdf = pdfTextArtifact;
			const extraction = pdf && {
				status: pdf.status,
				parser: 'liteparse',
				chars: pdf.chars,
				pages: pdf.pages,
			};
			const metadataPatch = {
				...(extraction ? { extraction } : {}),
				...(paperEnrichment ? { type: 'paper', data: paperEnrichment } : {}),
			};
			const updatePayload = buildProcessorUpdatePayload(
				article,
				finalResult,
				embedding,
				Object.keys(metadataPatch).length ? metadataPatch : undefined,
			);
			const platformMetadata = updatePayload.platform_metadata ?? article.platform_metadata;
			const entities = normalizeArticleEntityUpdatePayload(updatePayload, article.source, platformMetadata);

			await updateArticleAfterProcessing(db, target.table, target.rowId, updatePayload);
			if (target.table === 'articles' && entities) await syncArticleEntities(db, target.rowId, entities, article.source, platformMetadata);
			articleId = target.rowId;
		}
		if (youtubeTranscript || youtubeHighlights)
			await persistYouTubeWorkflowData(db, { transcript: youtubeTranscript, highlights: youtubeHighlights });
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
		const logContext =
			target.kind === 'source' ? { url: article.url, table: 'articles' } : { article_id: target.rowId, table: target.table };

		console.info({ tag: 'WORKFLOW', msg: 'Starting', sourceType, ...logContext });

		const hasContent = 'has_content' in article && !!article.has_content;
		const pdfTextArtifact =
			target.kind === 'stored' && target.table === 'user_files' && !hasContent && article.storage_key && article.file_type === PDF_MIME
				? await stagePdfTextExtraction(this.env, step, {
						sourceStorageKey: article.storage_key,
					})
				: null;

		const paperEnrichment = await stagePaperEnrichment(this.env, step, article, {
			hasStagedText: !!pdfTextArtifact?.text,
			loadContent: async () => (await loadFullTargetArticle(this.env, target, pdfTextArtifact)).content,
		});

		const processorResult = await step.do(
			'ai-analysis',
			{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '180 seconds' },
			async () => {
				const article = await loadFullTargetArticle(this.env, target, pdfTextArtifact);
				if (sourceType === 'hackernews') return processHackerNewsArticle(article, this.env);
				if (sourceType === 'twitter') return processTwitterArticle(article, this.env);
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
				persistWorkflowTarget(
					this.env,
					target,
					pdfTextArtifact?.text ? await loadFullTargetArticle(this.env, target, pdfTextArtifact) : article,
					processorResult,
					embedding,
					pdfTextArtifact,
					paperEnrichment,
					youtubeTranscript,
					youtubeHighlights,
				),
		);

		await syncPaperGraphForEnrichment(this.env, step, articleId, paperEnrichment);

		console.info({ tag: 'WORKFLOW', msg: 'Completed', article_id: articleId, ...logContext });
		return { success: true, article_id: articleId };
	}
}
