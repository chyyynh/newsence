import {
	insertFinalSourceArticle,
	type ProcessableTable,
	syncArticleEntities,
	USER_FILES_TABLE,
	updateProcessedArticle,
} from '@shared/article-store';
import { withDbTransaction } from '@shared/db';
import { type SourceArticleDraft, sourceDraftTwitterSourceEvent, sourceDraftYoutubeTranscript } from '@shared/source-draft';
import type { Article, Env } from '@shared/types';
import { recordUserFileWorkflowComplete, recordUserFileWorkflowFailed } from '@shared/user-file-workflow-state';
import { validateImageUrl } from '@shared/web';
import type { WorkflowQueueTarget } from '@shared/workflow-queue';
import { saveYouTubeHighlights, upsertYoutubeTranscript } from '@shared/youtube-transcripts';
import { buildProcessorUpdatePayload, type ProcessorResult } from '../domain/processors';
import { upsertTwitterSourceEvent } from '../platforms/twitter/source-events';
import type { YouTubeHighlightsUpdate } from '../platforms/youtube/highlights';
import type { PdfTextTempResult } from './pdf-text-temp';
import { readPdfTextTemp } from './pdf-text-temp';

const OG_IMAGE_UPDATE_KEY = 'og_image_url';

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
};

type SourceFinalInsert = {
	article: SourceArticleDraft['article'];
	updatePayload: Record<string, unknown>;
};

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
	const finalInsert = await prepareSourceFinalInsert(draft.article, fullArticle, input.result, input.embedding);
	const twitterSourceEvent = sourceDraftTwitterSourceEvent(draft);
	const youtubeTranscript = sourceDraftYoutubeTranscript(draft);
	return withDbTransaction(env, 'source article', async (db) => {
		const articleId = await insertFinalSourceArticle(db, finalInsert.article, finalInsert.updatePayload);
		if (youtubeTranscript) await upsertYoutubeTranscript(db, youtubeTranscript);
		if (input.result.updateData.entities?.length) await syncArticleEntities(db, articleId, input.result.updateData.entities);
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
): Promise<SourceFinalInsert> {
	const updatePayload = buildProcessorUpdatePayload(article, result, embedding);
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
	const updatePayload = buildProcessorUpdatePayload(input.article, finalResult, input.embedding, extractionMetadata(input.pdfTextTemp));

	return withDbTransaction(env, 'row workflow', async (db) => {
		await updateProcessedArticle(db, table, target.articleId, updatePayload);
		if (table === USER_FILES_TABLE) await recordUserFileWorkflowComplete(db, target.articleId, target.articleId);
		if (table !== USER_FILES_TABLE && finalResult.updateData.entities?.length)
			await syncArticleEntities(db, target.articleId, finalResult.updateData.entities);
		if (input.youtubeHighlights) await saveYouTubeHighlights(db, input.youtubeHighlights);
		return target.articleId;
	});
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
