import { insertFinalSourceArticle, type ProcessableTable, USER_FILES_TABLE, updateProcessedArticle } from '@core-shared/article-store';
import { withDbTransaction } from '@core-shared/db';
import type { PaperMetadata } from '@core-shared/platform-metadata';
import type { Article, Env } from '@core-shared/types';
import { validateImageUrl } from '@core-shared/web';
import { type ArticleEntityInput, isArticleEntityInput, normalizeArticleEntitiesForStorage } from '@entities/normalize';
import { syncArticleEntities } from '@entities/sync';
import { saveYouTubeHighlights, upsertYoutubeTranscript } from '@ingest/platforms/youtube/transcripts';
import {
	recordUserFileWorkflowComplete,
	recordUserFileWorkflowFailed,
	type SourceArticleDraft,
	type WorkflowQueueTarget,
} from '@ingest/workflows/queue';
import { buildProcessorUpdatePayload, type ProcessorResult } from '../domain/processors';
import { type PdfTextStatus, parsePdf } from '../extract';
import { upsertTwitterSourceEvent } from '../platforms/twitter/source-events';
import type { YouTubeHighlightsUpdate } from '../platforms/youtube/highlights';

const OG_IMAGE_UPDATE_KEY = 'og_image_url';
const TMP_PDF_TEXT_PREFIX = 'tmp/workflow/pdf-text/';
const PDF_TEXT_CONTENT_TYPE = 'text/markdown; charset=utf-8';

type RowTarget = Extract<WorkflowQueueTarget, { kind: 'row' }>;

export type WorkflowPersistenceContext = {
	target: WorkflowQueueTarget;
	table: ProcessableTable;
	readSourceDraft(): Promise<SourceArticleDraft>;
	readSourceArticle(): Promise<Article>;
};

export type WorkflowPersistenceInput = {
	article: Article;
	result: ProcessorResult;
	embedding: number[] | null;
	pdfTextTemp: PdfTextTempResult | null;
	youtubeHighlights: YouTubeHighlightsUpdate | null;
	paperEnrichment: PaperMetadata | null;
};

type SourceFinalInsert = {
	article: SourceArticleDraft['article'];
	updatePayload: Record<string, unknown>;
};

export interface PdfTextTempResult {
	status: PdfTextStatus | 'failed';
	chars: number;
	pages: number;
	textStorageKey?: string;
}

function assertPdfTextTempKey(key: string): void {
	if (!key.startsWith(TMP_PDF_TEXT_PREFIX)) throw new Error(`Invalid PDF text temp object key: ${key}`);
}

export async function createPdfTextTemp(env: Env, articleId: string, storageKey: string): Promise<PdfTextTempResult> {
	const obj = await env.R2.get(storageKey);
	if (!obj) throw new Error(`PDF source object missing: ${storageKey}`);
	const bytes = await obj.bytes();
	const { text, status, chars, pages } = await parsePdf(bytes);
	const textStorageKey = `${TMP_PDF_TEXT_PREFIX}${articleId}/${crypto.randomUUID()}.md`;
	await env.R2.put(textStorageKey, text, { httpMetadata: { contentType: PDF_TEXT_CONTENT_TYPE } });
	console.info({ tag: 'WORKFLOW', msg: 'PDF extracted', article_id: articleId, status, chars, pages });
	return { status, chars, pages, textStorageKey };
}

export async function readPdfTextTemp(env: Env, textStorageKey: string): Promise<string> {
	assertPdfTextTempKey(textStorageKey);
	const obj = await env.R2.get(textStorageKey);
	if (!obj) throw new Error(`PDF text temp object missing: ${textStorageKey}`);
	return obj.text();
}

export async function deletePdfTextTemp(env: Env, textStorageKey: string): Promise<void> {
	assertPdfTextTempKey(textStorageKey);
	await env.R2.delete(textStorageKey);
}

export async function persistWorkflowTarget(
	env: Env,
	context: WorkflowPersistenceContext,
	input: WorkflowPersistenceInput,
): Promise<string> {
	if (context.target.kind === 'source') return persistSourceTarget(env, context, input);
	return persistRowTarget(env, context.target, context.table, input);
}

export async function recordWorkflowFailure(env: Env, context: WorkflowPersistenceContext, error: unknown): Promise<void> {
	if (context.target.kind !== 'row' || context.table !== USER_FILES_TABLE) return;
	try {
		await recordUserFileWorkflowFailed(env, context.target.articleId, String(error));
	} catch (metadataError) {
		console.warn({
			tag: 'WORKFLOW',
			msg: 'Failed to record user_file workflow failure',
			article_id: context.target.articleId,
			error: String(metadataError),
		});
	}
}

async function persistSourceTarget(env: Env, context: WorkflowPersistenceContext, input: WorkflowPersistenceInput): Promise<string> {
	const draft = await context.readSourceDraft();
	const fullArticle = await context.readSourceArticle();
	const finalInsert = await prepareSourceFinalInsert(
		draft.article,
		fullArticle,
		input.result,
		input.embedding,
		paperMetadataPatch(input.paperEnrichment),
	);
	const platformMetadata = finalInsert.updatePayload.platform_metadata ?? finalInsert.article.platformMetadata;
	const entities = entityUpdatePayload(finalInsert.updatePayload, finalInsert.article.source, platformMetadata);
	const twitterSourceEvent = draft.attachments?.find((attachment) => attachment.kind === 'twitter-source-event')?.event;
	const youtubeTranscript = draft.attachments?.find((attachment) => attachment.kind === 'youtube-transcript')?.transcript;
	return withDbTransaction(env, 'source article', async (db) => {
		const articleId = await insertFinalSourceArticle(db, finalInsert.article, finalInsert.updatePayload);
		if (youtubeTranscript) await upsertYoutubeTranscript(db, youtubeTranscript);
		if (entities) await syncArticleEntities(db, articleId, entities, finalInsert.article.source, platformMetadata);
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
		return articleId;
	});
}

async function prepareSourceFinalInsert(
	base: SourceArticleDraft['article'],
	article: Article,
	result: ProcessorResult,
	embedding: number[] | null,
	metadataPatch: Record<string, unknown> | undefined,
): Promise<SourceFinalInsert> {
	const updatePayload = buildProcessorUpdatePayload(article, result, embedding, metadataPatch);
	const hasPayloadOgImage = Object.hasOwn(updatePayload, OG_IMAGE_UPDATE_KEY);
	const candidate = hasPayloadOgImage ? updatePayload[OG_IMAGE_UPDATE_KEY] : base.ogImageUrl;
	const validated = await validateImageUrl(typeof candidate === 'string' ? candidate : null);
	if (hasPayloadOgImage) return { article: base, updatePayload: { ...updatePayload, [OG_IMAGE_UPDATE_KEY]: validated } };
	return { article: { ...base, ogImageUrl: validated }, updatePayload };
}

async function persistRowTarget(env: Env, target: RowTarget, table: ProcessableTable, input: WorkflowPersistenceInput): Promise<string> {
	const extractedPdfText = input.pdfTextTemp?.textStorageKey ? await readPdfTextTemp(env, input.pdfTextTemp.textStorageKey) : null;
	const finalResult: ProcessorResult = {
		...input.result,
		updateData: {
			...input.result.updateData,
			...(extractedPdfText !== null ? { content: extractedPdfText } : {}),
		},
	};
	const metadataPatch = mergeMetadataPatches(extractionMetadata(input.pdfTextTemp), paperMetadataPatch(input.paperEnrichment));
	const updatePayload = buildProcessorUpdatePayload(input.article, finalResult, input.embedding, metadataPatch);
	const platformMetadata = updatePayload.platform_metadata ?? input.article.platform_metadata;
	const entities = entityUpdatePayload(updatePayload, input.article.source, platformMetadata);

	return withDbTransaction(env, 'row workflow', async (db) => {
		await updateProcessedArticle(db, table, target.articleId, updatePayload);
		if (table === USER_FILES_TABLE) await recordUserFileWorkflowComplete(db, target.articleId, target.articleId);
		if (table !== USER_FILES_TABLE && entities)
			await syncArticleEntities(db, target.articleId, entities, input.article.source, platformMetadata);
		if (input.youtubeHighlights) await saveYouTubeHighlights(db, input.youtubeHighlights);
		return target.articleId;
	});
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

/** Envelope patch that promotes an article to the `paper` platform type. */
function paperMetadataPatch(paper: PaperMetadata | null): Record<string, unknown> | undefined {
	return paper ? { type: 'paper', data: paper } : undefined;
}

/** Shallow-merge metadata patches, dropping the key entirely when all are empty. */
function mergeMetadataPatches(...patches: Array<Record<string, unknown> | undefined>): Record<string, unknown> | undefined {
	const merged: Record<string, unknown> = {};
	for (const patch of patches) if (patch) Object.assign(merged, patch);
	return Object.keys(merged).length > 0 ? merged : undefined;
}

function extractionMetadata(pdfTextTemp: PdfTextTempResult | null): Record<string, unknown> | undefined {
	if (!pdfTextTemp) return undefined;
	return {
		extraction: {
			status: pdfTextTemp.status,
			parser: 'liteparse',
			...(pdfTextTemp.status === 'failed' ? {} : { chars: pdfTextTemp.chars, pages: pdfTextTemp.pages }),
		},
	};
}
