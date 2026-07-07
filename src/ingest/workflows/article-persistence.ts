import { insertFinalSourceArticle, type ProcessableTable, USER_FILES_TABLE, updateProcessedArticle } from '@core-shared/article-store';
import type { PaperMetadata } from '@core-shared/platform-metadata';
import type { Article } from '@core-shared/types';
import { type ArticleEntityInput, isArticleEntityInput, normalizeArticleEntitiesForStorage } from '@entities/normalize';
import { syncArticleEntities } from '@entities/sync';
import { saveYouTubeHighlights, upsertYoutubeTranscript } from '@ingest/platforms/youtube/transcripts';
import { recordUserFileWorkflowComplete, type SourceArticleDraft, type WorkflowTarget } from '@ingest/workflows/queue';
import { Client } from 'pg';
import { buildProcessorUpdatePayload, type ProcessorResult } from '../domain/processors';
import type { PdfTextStatus } from '../extract';
import { upsertTwitterSourceEvent } from '../platforms/twitter/persistence';
import type { YouTubeHighlightsUpdate } from '../platforms/youtube/highlights';

type RowTarget = Extract<WorkflowTarget, { kind: 'row' }>;

export type WorkflowPersistenceContext = {
	target: WorkflowTarget;
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

export interface PdfTextTempResult {
	status: PdfTextStatus | 'failed';
	chars: number;
	pages: number;
	textStorageKey?: string;
}

export async function persistWorkflowTarget(
	env: Env,
	context: WorkflowPersistenceContext,
	input: WorkflowPersistenceInput,
): Promise<string> {
	if (context.target.kind === 'source') return persistSourceTarget(env, context, input);
	return persistRowTarget(env, context.target, context.table, input);
}

async function persistSourceTarget(env: Env, context: WorkflowPersistenceContext, input: WorkflowPersistenceInput): Promise<string> {
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
