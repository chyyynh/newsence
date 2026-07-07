import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { generateArticleEmbedding, prepareArticleTextForEmbedding } from '@core-ai/embedding';
import {
	ARTICLES_TABLE,
	loadProcessableArticle,
	type ProcessableArticleShell,
	type ProcessableTable,
	USER_FILES_TABLE,
} from '@core-shared/article-store';
import { PDF_MIME } from '@core-shared/mime';
import type { PaperMetadata } from '@core-shared/platform-metadata';
import type { Article, TranscriptSegment } from '@core-shared/types';
import {
	cleanupSourceArticleDraftRef,
	readSourceArticleDraft,
	type SourceArticleDraft,
	type WorkflowQueueTarget,
} from '@ingest/workflows/queue';
import { syncPaperGraph } from '@papers/sync';
import { runArticleProcessor } from '../domain/processors';
import { detectPaperId, extractPaperTitle } from '../platforms/paper/detect';
import { enrichPaperByTitle, enrichPaperFromId } from '../platforms/paper/openalex';
import { enrichS2ByTitle, enrichS2FromId } from '../platforms/paper/semanticscholar';
import {
	prepareYouTubeHighlights,
	prepareYouTubeHighlightsFromTranscript,
	type YouTubeHighlightsUpdate,
} from '../platforms/youtube/highlights';
import {
	createPdfTextTemp,
	deletePdfTextTemp,
	type PdfTextTempResult,
	persistWorkflowTarget,
	readPdfTextTemp,
	recordWorkflowFailure,
} from './article-persistence';

type WorkflowParams = {
	target: WorkflowQueueTarget;
};

type WorkflowRunContext = {
	target: WorkflowQueueTarget;
	table: ProcessableTable;
	readSourceDraft(): Promise<SourceArticleDraft>;
	readSourceArticle(): Promise<Article>;
};
type YoutubeHighlightsInput =
	| { kind: 'transcript'; videoId: string; segments: TranscriptSegment[] }
	| { kind: 'article'; article: Article };

function createWorkflowRunContext(env: Env, target: WorkflowQueueTarget): WorkflowRunContext {
	let draft: Promise<SourceArticleDraft> | undefined;
	let article: Promise<Article> | undefined;

	const readSourceDraft = () => {
		if (target.kind !== 'source') throw new Error('Source draft requested for row workflow target');
		draft ??= readSourceArticleDraft(env, target.sourceArticle).catch((error) => {
			draft = undefined;
			article = undefined;
			throw error;
		});
		return draft;
	};

	return {
		target,
		table: target.kind === 'row' ? (target.targetTable ?? ARTICLES_TABLE) : ARTICLES_TABLE,
		readSourceDraft,
		readSourceArticle: () => {
			article ??= readSourceDraft().then((draft) => {
				const data = draft.article;
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
					og_image_url: data.ogImageUrl,
					platform_metadata: data.platformMetadata as Article['platform_metadata'],
				};
			});
			return article;
		},
	};
}

function targetLogContext(context: WorkflowRunContext, article: Article): Record<string, string> {
	return context.target.kind === 'row'
		? { article_id: context.target.articleId, table: context.table }
		: { url: article.url, table: context.table };
}

async function loadTargetShell(env: Env, context: WorkflowRunContext): Promise<ProcessableArticleShell> {
	if (context.target.kind !== 'source') return loadProcessableArticle(env, context.table, context.target.articleId, true);
	return { ...(await context.readSourceArticle()), content: null };
}

async function loadFullTargetArticle(env: Env, context: WorkflowRunContext, pdfTextTemp: PdfTextTempResult | null): Promise<Article> {
	const article =
		context.target.kind === 'source'
			? await context.readSourceArticle()
			: await loadProcessableArticle(env, context.table, context.target.articleId);
	return pdfTextTemp?.textStorageKey ? { ...article, content: await readPdfTextTemp(env, pdfTextTemp.textStorageKey) } : article;
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
			() => createPdfTextTemp(env, target.articleId, storageKey),
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
// pulls structured metadata + references from OpenAlex. Never fails the workflow:
// a non-paper resolves to null cheaply, and any OpenAlex error is swallowed.
async function enrichPaperMetadata(
	env: Env,
	context: WorkflowRunContext,
	shell: ProcessableArticleShell,
	pdfTextTemp: PdfTextTempResult | null,
	step: WorkflowStep,
): Promise<PaperMetadata | null> {
	const hasStagedText = !!pdfTextTemp?.textStorageKey;
	const isPdfRow = shell.file_type === 'application/pdf';
	// Bail before scheduling a step unless this could be a paper: staged PDF text
	// (fresh upload), an already-extracted PDF row (retry), or a URL paper signal.
	if (!hasStagedText && !isPdfRow && !detectPaperId(shell.url, null, { scanContent: false }).hasAcademicMarker) return null;

	try {
		return step.do(
			'enrich-paper-metadata',
			{ retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () => {
				// Content comes from the staged temp (fresh) or the persisted
				// extracted_text (retry); loadFullTargetArticle resolves both.
				const content = (await loadFullTargetArticle(env, context, pdfTextTemp)).content;
				const detection = detectPaperId(shell.url, content, { scanContent: !!content });
				// Prefer the title parsed from the PDF body over the (often noisy,
				// filename-derived) row title — the latter rarely matches a search. For
				// uploaded PDFs, a title search is attempted even without a DOI marker
				// (placeholder/absent DOIs, or markers stripped by content cleanup) — the
				// Dice title match guards against false positives.
				const searchTitle = (content ? extractPaperTitle(content) : null) ?? shell.title;
				const canTitleSearch = detection.hasAcademicMarker || isPdfRow;
				const apiKey = env.S2_API_KEY;

				// Semantic Scholar is primary — OpenAlex rate-limits shared Worker IPs.
				let paper =
					(detection.id ? await enrichS2FromId(detection.id, apiKey) : null) ??
					(canTitleSearch && searchTitle ? await enrichS2ByTitle(searchTitle, apiKey) : null);
				// OpenAlex fallback (usually 429s from Workers, but works via other egress).
				if (!paper) {
					paper =
						(detection.id ? await enrichPaperFromId(detection.id) : null) ??
						(canTitleSearch && searchTitle ? await enrichPaperByTitle(searchTitle) : null);
				}
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

async function cleanupTargetTemps(
	env: Env,
	context: WorkflowRunContext,
	pdfTextTemp: PdfTextTempResult | null,
	step: WorkflowStep,
): Promise<void> {
	const { target } = context;
	if (!pdfTextTemp?.textStorageKey && target.kind !== 'source') return;

	await step.do('cleanup-workflow-temp-objects', { retries: { limit: 1, delay: '5 seconds' }, timeout: '20 seconds' }, () =>
		cleanupWorkflowTempObjects(env, context, pdfTextTemp),
	);
}

async function cleanupWorkflowTempObjects(env: Env, context: WorkflowRunContext, pdfTextTemp: PdfTextTempResult | null): Promise<void> {
	const { target } = context;
	const failures: Array<{ object: string; key: string; error: string }> = [];
	const deleteTemp = async (object: string, key: string, deleteFn: () => Promise<void>) => {
		try {
			await deleteFn();
		} catch (error) {
			failures.push({ object, key, error: String(error) });
		}
	};

	if (pdfTextTemp?.textStorageKey) {
		await deleteTemp('pdf_text', pdfTextTemp.textStorageKey, () => deletePdfTextTemp(env, pdfTextTemp.textStorageKey!));
	}

	if (target.kind === 'source') {
		await cleanupSourceArticleDraftRef(env, target.sourceArticle, { reason: 'workflow completed', logTag: 'WORKFLOW' });
	}

	if (failures.length) console.warn({ tag: 'WORKFLOW', msg: 'Temp object cleanup incomplete', failures });
}

export class NewsenceMonitorWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
	async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
		const context = createWorkflowRunContext(this.env, event.payload.target);
		try {
			const article = await step.do(
				context.target.kind === 'source' ? 'load-source-article-shell' : 'fetch-article-shell',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() => loadTargetShell(this.env, context),
			);
			const sourceType = article.source_type ?? 'default';

			console.info({ tag: 'WORKFLOW', msg: 'Starting', sourceType, ...targetLogContext(context, article) });

			const pdfTextTemp = await stagePdfExtraction(this.env, context, article, step);

			const paperEnrichment = await enrichPaperMetadata(this.env, context, article, pdfTextTemp, step);

			const processorResult = await step.do(
				'ai-analysis',
				{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '180 seconds' },
				async () =>
					runArticleProcessor(await loadFullTargetArticle(this.env, context, pdfTextTemp), sourceType, {
						env: this.env,
						table: context.table,
					}),
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

			await cleanupTargetTemps(this.env, context, pdfTextTemp, step);

			console.info({ tag: 'WORKFLOW', msg: 'Completed', article_id: articleId, ...targetLogContext(context, article) });
			return { success: true, article_id: articleId };
		} catch (error) {
			await recordWorkflowFailure(this.env, context, error);
			throw error;
		}
	}
}
