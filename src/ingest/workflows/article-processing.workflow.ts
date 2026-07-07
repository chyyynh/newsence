import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { generateArticleEmbedding, prepareArticleTextForEmbedding } from '@core-ai/embedding';
import {
	ARTICLES_TABLE,
	insertFinalSourceArticle,
	loadProcessableArticle,
	type ProcessableArticleShell,
	type ProcessableTable,
	USER_FILES_TABLE,
	updateProcessedArticle,
} from '@core-shared/article-store';
import { PDF_MIME } from '@core-shared/mime';
import type { PaperMetadata } from '@core-shared/platform-metadata';
import type { Article, TranscriptSegment } from '@core-shared/types';
import { type ArticleEntityInput, isArticleEntityInput, normalizeArticleEntitiesForStorage } from '@entities/normalize';
import { syncArticleEntities } from '@entities/sync';
import {
	recordUserFileWorkflowComplete,
	recordUserFileWorkflowFailed,
	type SourceArticleDraft,
	type WorkflowTarget,
} from '@ingest/workflows/queue';
import { syncPaperGraph } from '@papers/sync';
import { Client } from 'pg';
import { articleProcessors, buildProcessorUpdatePayload, type ProcessorResult } from '../domain/processors';
import { type PdfTextStatus, parsePdf } from '../extract';
import { detectPaperId, extractPaperTitle } from '../platforms/paper/detect';
import { enrichS2ByTitle, enrichS2FromId } from '../platforms/paper/semanticscholar';
import { upsertTwitterSourceEvent } from '../platforms/twitter/persistence';
import {
	prepareYouTubeHighlights,
	prepareYouTubeHighlightsFromTranscript,
	saveYouTubeHighlights,
	upsertYoutubeTranscript,
	type YouTubeHighlightsUpdate,
} from '../platforms/youtube/transcripts';

type WorkflowParams = {
	target: WorkflowTarget;
};

const TMP_PDF_TEXT_PREFIX = 'tmp/workflow/pdf-text/';
const PDF_TEXT_CONTENT_TYPE = 'text/markdown; charset=utf-8';

type WorkflowRunContext = {
	target: WorkflowTarget;
	table: ProcessableTable;
	readSourceDraft(): Promise<SourceArticleDraft>;
	readSourceArticle(): Promise<Article>;
};
type YoutubeHighlightsInput =
	| { kind: 'transcript'; videoId: string; segments: TranscriptSegment[] }
	| { kind: 'article'; article: Article };
type RowTarget = Extract<WorkflowTarget, { kind: 'row' }>;
type WorkflowPersistenceInput = {
	article: Article;
	result: ProcessorResult;
	embedding: number[] | null;
	pdfTextTemp: PdfTextTempResult | null;
	youtubeHighlights: YouTubeHighlightsUpdate | null;
	paperEnrichment: PaperMetadata | null;
};

interface PdfTextTempResult {
	status: PdfTextStatus | 'failed';
	chars: number;
	pages: number;
	textStorageKey?: string;
}

function createWorkflowRunContext(env: Env, target: WorkflowTarget): WorkflowRunContext {
	const readSourceDraft = async () => {
		if (target.kind !== 'source') throw new Error('Source draft requested for row workflow target');
		const obj = await env.R2.get(target.sourceArticle.r2Key);
		if (!obj) throw new Error(`source article draft missing: ${target.sourceArticle.r2Key}`);
		return obj.json<SourceArticleDraft>();
	};

	return {
		target,
		table: target.kind === 'row' ? (target.targetTable ?? ARTICLES_TABLE) : ARTICLES_TABLE,
		readSourceDraft,
		readSourceArticle: async () => {
			const data = (await readSourceDraft()).article;
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
				og_image_url: null,
				platform_metadata: data.platformMetadata as Article['platform_metadata'],
			};
		},
	};
}

async function loadFullTargetArticle(env: Env, context: WorkflowRunContext, pdfTextTemp: PdfTextTempResult | null): Promise<Article> {
	const article =
		context.target.kind === 'source'
			? await context.readSourceArticle()
			: await loadProcessableArticle(env, context.table, context.target.articleId);
	if (!pdfTextTemp?.textStorageKey) return article;
	const pdfTextObj = await env.R2.get(pdfTextTemp.textStorageKey);
	if (!pdfTextObj) throw new Error(`PDF text temp object missing: ${pdfTextTemp.textStorageKey}`);
	return { ...article, content: await pdfTextObj.text() };
}

async function stagePdfExtraction(
	env: Env,
	context: WorkflowRunContext,
	article: ProcessableArticleShell,
	step: WorkflowStep,
): Promise<PdfTextTempResult | null> {
	const { target, table } = context;
	const storageKey = article.storage_key;
	if (
		target.kind !== 'row' ||
		table !== USER_FILES_TABLE ||
		article.has_content ||
		!storageKey ||
		!(article.origin_type === 'upload' || article.origin_type === 'saved_url') ||
		article.file_type !== PDF_MIME
	) {
		return null;
	}

	try {
		const pdfTextTemp = await step.do(
			'extract-pdf-text',
			{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
			async () => {
				const obj = await env.R2.get(storageKey);
				if (!obj) throw new Error(`PDF source object missing: ${storageKey}`);
				const { text, status, chars, pages } = await parsePdf(new Uint8Array(await obj.arrayBuffer()));
				const textStorageKey = `${TMP_PDF_TEXT_PREFIX}${target.articleId}/${crypto.randomUUID()}.md`;
				await env.R2.put(textStorageKey, text, { httpMetadata: { contentType: PDF_TEXT_CONTENT_TYPE } });
				console.info({ tag: 'WORKFLOW', msg: 'PDF extracted', article_id: target.articleId, status, chars, pages });
				return { status, chars, pages, textStorageKey };
			},
		);
		console.info({
			tag: 'WORKFLOW',
			msg: 'PDF extraction staged',
			article_id: target.articleId,
			status: pdfTextTemp.status,
			chars: pdfTextTemp.chars,
		});
		return pdfTextTemp;
	} catch (error) {
		console.warn({
			tag: 'WORKFLOW',
			msg: 'PDF extraction failed, continuing without content',
			article_id: target.articleId,
			error: String(error),
		});
		return { status: 'failed', chars: 0, pages: 0 };
	}
}

// Best-effort academic-paper enrichment. Detects a DOI/arXiv id from the URL
// (always) or the extracted PDF text (only when we have staged PDF text), then
// pulls structured metadata + references from Semantic Scholar. Never fails the
// workflow: a non-paper resolves to null cheaply, and API errors are swallowed.
async function enrichPaperMetadata(
	env: Env,
	context: WorkflowRunContext,
	shell: ProcessableArticleShell,
	pdfTextTemp: PdfTextTempResult | null,
	step: WorkflowStep,
): Promise<PaperMetadata | null> {
	const hasStagedText = !!pdfTextTemp?.textStorageKey;
	const isPdfRow = shell.file_type === PDF_MIME;
	// Bail before scheduling a step unless this could be a paper: staged PDF text
	// (fresh upload), an already-extracted PDF row (retry), or a URL paper signal.
	if (!hasStagedText && !isPdfRow && !detectPaperId(shell.url, null, false).hasAcademicMarker) return null;

	try {
		return step.do(
			'enrich-paper-metadata',
			{ retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => {
				// Content comes from the staged temp (fresh) or the persisted
				// extracted_text (retry); loadFullTargetArticle resolves both.
				const content = (await loadFullTargetArticle(env, context, pdfTextTemp)).content;
				const detection = detectPaperId(shell.url, content, !!content);
				// Prefer the title parsed from the PDF body over the (often noisy,
				// filename-derived) row title — the latter rarely matches a search. For
				// uploaded PDFs, a title search is attempted even without a DOI marker
				// (placeholder/absent DOIs, or markers stripped by content cleanup) — the
				// Dice title match guards against false positives.
				const searchTitle = (content ? extractPaperTitle(content) : null) ?? shell.title;
				const canTitleSearch = detection.hasAcademicMarker || isPdfRow;
				const apiKey = env.S2_API_KEY;

				const paper =
					(detection.id ? await enrichS2FromId(detection.id, apiKey) : null) ??
					(canTitleSearch && searchTitle ? await enrichS2ByTitle(searchTitle, apiKey) : null);
				if (paper) {
					console.info({
						tag: 'WORKFLOW',
						msg: 'Paper enriched',
						source: paper.source,
						doi: paper.doi,
						refs: paper.references.length,
					});
				}
				return paper;
			},
		);
	} catch (error) {
		console.warn({ tag: 'WORKFLOW', msg: 'Paper enrichment failed, continuing', url: shell.url, error: String(error) });
		return null;
	}
}

// Promote the resolved paper + its references into the relational citation graph
// (papers / paper_references). Runs in its own transaction inside syncPaperGraph,
// so a DOI collision here can't roll back the already-persisted article. Fully
// non-fatal — a graph failure is logged and the workflow still succeeds.
async function syncPaperGraphStep(env: Env, articleId: string, paperEnrichment: PaperMetadata | null, step: WorkflowStep): Promise<void> {
	if (!paperEnrichment?.openAlexId) return;
	try {
		const summary = await step.do(
			'sync-paper-graph',
			{ retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			() => syncPaperGraph(env, articleId, paperEnrichment),
		);
		console.info({ tag: 'WORKFLOW', msg: 'Paper graph synced', article_id: articleId, edges: summary?.edges ?? 0 });
	} catch (error) {
		console.warn({ tag: 'WORKFLOW', msg: 'Paper graph sync failed, continuing', article_id: articleId, error: String(error) });
	}
}

async function prepareYoutubeHighlights(
	env: Env,
	context: WorkflowRunContext,
	article: Article,
	sourceType: string,
	step: WorkflowStep,
): Promise<YouTubeHighlightsUpdate | null> {
	if (article.platform_metadata?.type !== 'youtube') return null;

	let input: YoutubeHighlightsInput | null = null;
	if (context.target.kind === 'source') {
		const draft = await context.readSourceDraft();
		const transcript = draft.attachments?.find((attachment) => attachment.kind === 'youtube-transcript')?.transcript;
		if (!transcript) return null;
		input = {
			kind: 'transcript',
			videoId: article.platform_metadata.data.videoId,
			segments: transcript.segments as TranscriptSegment[],
		};
	} else if (sourceType === 'youtube') {
		input = { kind: 'article', article };
	}
	if (!input) return null;

	return step.do(
		'generate-youtube-highlights',
		{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
		() =>
			input.kind === 'transcript'
				? prepareYouTubeHighlightsFromTranscript(env, input.videoId, input.segments)
				: prepareYouTubeHighlights(env, input.article),
	);
}

async function cleanupWorkflowTempObjects(env: Env, context: WorkflowRunContext, pdfTextTemp: PdfTextTempResult | null): Promise<void> {
	const { target } = context;
	const failures: Array<{ object: string; key: string; error: string }> = [];

	if (pdfTextTemp?.textStorageKey) {
		try {
			await env.R2.delete(pdfTextTemp.textStorageKey);
		} catch (error) {
			failures.push({ object: 'pdf_text', key: pdfTextTemp.textStorageKey, error: String(error) });
		}
	}

	if (target.kind === 'source') {
		try {
			await env.R2.delete(target.sourceArticle.r2Key);
		} catch (error) {
			failures.push({ object: 'source_article_draft', key: target.sourceArticle.r2Key, error: String(error) });
		}
	}

	if (failures.length) console.warn({ tag: 'WORKFLOW', msg: 'Temp object cleanup incomplete', failures });
}

async function persistWorkflowTarget(env: Env, context: WorkflowRunContext, input: WorkflowPersistenceInput): Promise<string> {
	if (context.target.kind === 'source') return persistSourceTarget(env, context, input);
	return persistRowTarget(env, context.target, context.table, input);
}

async function persistSourceTarget(env: Env, context: WorkflowRunContext, input: WorkflowPersistenceInput): Promise<string> {
	const draft = await context.readSourceDraft();
	const fullArticle = await context.readSourceArticle();
	let articleForInsert = draft.article;
	let updatePayload = buildProcessorUpdatePayload(
		fullArticle,
		input.result,
		input.embedding,
		input.paperEnrichment ? { type: 'paper', data: input.paperEnrichment } : undefined,
	);
	if (Object.hasOwn(updatePayload, 'og_image_url')) {
		updatePayload = { ...updatePayload, og_image_url: null };
	} else {
		articleForInsert = { ...draft.article, ogImageUrl: null };
	}
	const platformMetadata = updatePayload.platform_metadata ?? articleForInsert.platformMetadata;
	const entities = entityUpdatePayload(updatePayload, articleForInsert.source, platformMetadata);
	const twitterSourceEvent = draft.attachments?.find((attachment) => attachment.kind === 'twitter-source-event')?.event;
	const youtubeTranscript = draft.attachments?.find((attachment) => attachment.kind === 'youtube-transcript')?.transcript;
	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	await db.query('BEGIN');
	try {
		const articleId = await insertFinalSourceArticle(db, articleForInsert, updatePayload);
		if (youtubeTranscript) await upsertYoutubeTranscript(db, youtubeTranscript);
		if (entities) await syncArticleEntities(db, articleId, entities, articleForInsert.source, platformMetadata);
		if (input.youtubeHighlights) await saveYouTubeHighlights(db, input.youtubeHighlights);
		if (twitterSourceEvent) {
			await upsertTwitterSourceEvent(db, twitterSourceEvent.tweet, {
				articleId,
				eventType: twitterSourceEvent.eventType,
				text: twitterSourceEvent.text,
				media: twitterSourceEvent.media,
				raw: twitterSourceEvent.raw,
			});
		}
		await db.query('COMMIT');
		return articleId;
	} catch (error) {
		await db
			.query('ROLLBACK')
			.catch((rollbackError) => console.error({ tag: 'DB', msg: 'source article rollback failed', error: String(rollbackError) }));
		throw error;
	}
}

async function persistRowTarget(env: Env, target: RowTarget, table: ProcessableTable, input: WorkflowPersistenceInput): Promise<string> {
	const pdfTextObj = input.pdfTextTemp?.textStorageKey ? await env.R2.get(input.pdfTextTemp.textStorageKey) : null;
	if (input.pdfTextTemp?.textStorageKey && !pdfTextObj)
		throw new Error(`PDF text temp object missing: ${input.pdfTextTemp.textStorageKey}`);
	const extractedPdfText = pdfTextObj ? await pdfTextObj.text() : null;
	const finalResult: ProcessorResult = {
		...input.result,
		updateData: {
			...input.result.updateData,
			...(extractedPdfText !== null ? { content: extractedPdfText } : {}),
		},
	};
	const metadataPatch: Record<string, unknown> = {
		...(input.pdfTextTemp
			? {
					extraction: {
						status: input.pdfTextTemp.status,
						parser: 'liteparse',
						...(input.pdfTextTemp.status === 'failed' ? {} : { chars: input.pdfTextTemp.chars, pages: input.pdfTextTemp.pages }),
					},
				}
			: {}),
		...(input.paperEnrichment ? { type: 'paper', data: input.paperEnrichment } : {}),
	};
	const updatePayload = buildProcessorUpdatePayload(
		input.article,
		finalResult,
		input.embedding,
		Object.keys(metadataPatch).length ? metadataPatch : undefined,
	);
	const platformMetadata = updatePayload.platform_metadata ?? input.article.platform_metadata;
	const entities = entityUpdatePayload(updatePayload, input.article.source, platformMetadata);

	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	await db.query('BEGIN');
	try {
		await updateProcessedArticle(db, table, target.articleId, updatePayload);
		if (table === USER_FILES_TABLE) await recordUserFileWorkflowComplete(db, target.articleId, target.articleId);
		if (table !== USER_FILES_TABLE && entities)
			await syncArticleEntities(db, target.articleId, entities, input.article.source, platformMetadata);
		if (input.youtubeHighlights) await saveYouTubeHighlights(db, input.youtubeHighlights);
		await db.query('COMMIT');
		return target.articleId;
	} catch (error) {
		await db
			.query('ROLLBACK')
			.catch((rollbackError) => console.error({ tag: 'DB', msg: 'row workflow rollback failed', error: String(rollbackError) }));
		throw error;
	}
}

function entityUpdatePayload(
	updatePayload: Record<string, unknown>,
	source?: string | null,
	platformMetadata?: unknown,
): ArticleEntityInput[] | null {
	if (!Array.isArray(updatePayload.entities)) return null;
	const entities = normalizeArticleEntitiesForStorage(updatePayload.entities.filter(isArticleEntityInput), source, platformMetadata);
	updatePayload.entities = entities;
	return entities;
}

export class NewsenceMonitorWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
	async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
		const context = createWorkflowRunContext(this.env, event.payload.target);
		try {
			const article = await step.do(
				context.target.kind === 'source' ? 'load-source-article-shell' : 'fetch-article-shell',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				async () =>
					context.target.kind === 'source'
						? { ...(await context.readSourceArticle()), content: null }
						: loadProcessableArticle(this.env, context.table, context.target.articleId, true),
			);
			const sourceType = article.source_type ?? 'default';
			const logContext =
				context.target.kind === 'row'
					? { article_id: context.target.articleId, table: context.table }
					: { url: article.url, table: context.table };

			console.info({ tag: 'WORKFLOW', msg: 'Starting', sourceType, ...logContext });

			const pdfTextTemp = await stagePdfExtraction(this.env, context, article, step);

			const paperEnrichment = await enrichPaperMetadata(this.env, context, article, pdfTextTemp, step);

			const processorResult = await step.do(
				'ai-analysis',
				{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '180 seconds' },
				async () =>
					(articleProcessors[sourceType] ?? articleProcessors.default).process(
						await loadFullTargetArticle(this.env, context, pdfTextTemp),
						{ env: this.env, table: context.table },
					),
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

			const youtubeHighlights = await prepareYoutubeHighlights(this.env, context, article, sourceType, step);
			const articleId = await step.do(
				context.target.kind === 'source' ? 'insert-final-article' : 'update-db',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() =>
					persistWorkflowTarget(this.env, context, {
						article,
						result: processorResult,
						embedding,
						pdfTextTemp,
						youtubeHighlights,
						paperEnrichment,
					}),
			);

			await syncPaperGraphStep(this.env, articleId, paperEnrichment, step);

			if (pdfTextTemp?.textStorageKey || context.target.kind === 'source') {
				await step.do('cleanup-workflow-temp-objects', { retries: { limit: 1, delay: '5 seconds' }, timeout: '20 seconds' }, () =>
					cleanupWorkflowTempObjects(this.env, context, pdfTextTemp),
				);
			}

			console.info({ tag: 'WORKFLOW', msg: 'Completed', article_id: articleId, ...logContext });
			return { success: true, article_id: articleId };
		} catch (error) {
			if (context.target.kind === 'row' && context.table === USER_FILES_TABLE) {
				try {
					await recordUserFileWorkflowFailed(this.env, context.target.articleId, String(error));
				} catch (metadataError) {
					console.warn({
						tag: 'WORKFLOW',
						msg: 'Failed to record user_file workflow failure',
						article_id: context.target.articleId,
						error: String(metadataError),
					});
				}
			}
			throw error;
		}
	}
}
