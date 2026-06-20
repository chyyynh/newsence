import {
	getUserFileWorkflowInstanceId,
	type InsertArticleData,
	type ProcessableTable,
	recordUserFileWorkflowInstanceId,
	resolveProcessableTable,
	USER_FILES_TABLE,
	withDbClient,
	type YoutubeTranscriptRow,
} from './db';
import type { TwitterMedia } from './platform-metadata';
import { deleteTempObject, putRandomSerializedTempJson, readTempJson } from './r2-temp';
import type { Article, Env, Tweet } from './types';

type TwitterSourceEventType = 'tweet' | 'thread' | 'share' | 'quote' | 'retweet' | 'article';

export type TwitterSourceEventDraft = {
	tweet: Tweet;
	eventType: TwitterSourceEventType;
	text?: string | null;
	media?: TwitterMedia[];
	raw?: unknown;
};

export type SourceArticleAttachment =
	| { kind: 'youtube-transcript'; transcript: YoutubeTranscriptRow }
	| { kind: 'twitter-source-event'; event: TwitterSourceEventDraft };

export interface SourceArticleDraft {
	article: InsertArticleData;
	attachments?: SourceArticleAttachment[];
}

type LegacySourceArticleDraft = SourceArticleDraft & {
	youtubeTranscript?: YoutubeTranscriptRow;
	twitterSourceEvent?: TwitterSourceEventDraft;
};

export type SourceArticleDraftRef = { url: string; inline: SourceArticleDraft } | { url: string; r2Key: string };

export type WorkflowQueueTarget =
	| { kind: 'row'; articleId: string; targetTable?: ProcessableTable }
	| { kind: 'source'; sourceArticle: SourceArticleDraftRef };

export type QueueMessage = { type: 'workflow_process'; target: WorkflowQueueTarget };

const SOURCE_ARTICLE_DRAFT_PREFIX = 'tmp/workflow/source-articles/';
const MAX_INLINE_SOURCE_ARTICLE_BYTES = 110_000;
const ACTIVE_WORKFLOW_STATUSES = new Set(['queued', 'running', 'paused', 'waiting', 'waitingForPause']);

export async function enqueueArticleProcess(env: Env, articleId: string, targetTable?: ProcessableTable): Promise<void> {
	await env.ARTICLE_QUEUE.send({
		type: 'workflow_process',
		target: rowWorkflowTarget(articleId, targetTable),
	});
}

export async function enqueueArticleBatchProcess(env: Env, articleIds: string[], targetTable?: ProcessableTable): Promise<void> {
	if (!articleIds.length) return;
	await env.ARTICLE_QUEUE.sendBatch(
		articleIds.map((articleId) => ({
			body: {
				type: 'workflow_process',
				target: rowWorkflowTarget(articleId, targetTable),
			},
		})),
	);
}

function rowWorkflowTarget(articleId: string, targetTable?: ProcessableTable): WorkflowQueueTarget {
	return {
		kind: 'row',
		articleId,
		...(targetTable ? { targetTable } : {}),
	};
}

export async function enqueueSourceArticleProcess(env: Env, draft: SourceArticleDraft): Promise<void> {
	const sourceArticle = await createSourceArticleDraftRef(env, draft);

	try {
		await env.ARTICLE_QUEUE.send({
			type: 'workflow_process',
			target: { kind: 'source', sourceArticle },
		});
	} catch (err) {
		await cleanupSourceArticleDraftRef(env, sourceArticle, { reason: 'enqueue failed' });
		throw err;
	}
}

export function youtubeTranscriptAttachment(transcript: YoutubeTranscriptRow): SourceArticleAttachment {
	return { kind: 'youtube-transcript', transcript };
}

export function twitterSourceEventAttachment(event: TwitterSourceEventDraft): SourceArticleAttachment {
	return { kind: 'twitter-source-event', event };
}

export function sourceDraftYoutubeTranscript(draft: SourceArticleDraft): YoutubeTranscriptRow | undefined {
	return draft.attachments?.find((attachment) => attachment.kind === 'youtube-transcript')?.transcript;
}

export function sourceDraftTwitterSourceEvent(draft: SourceArticleDraft): TwitterSourceEventDraft | undefined {
	return draft.attachments?.find((attachment) => attachment.kind === 'twitter-source-event')?.event;
}

function normalizeSourceArticleDraft(draft: LegacySourceArticleDraft): SourceArticleDraft {
	const attachments = [...(draft.attachments ?? [])];
	if (draft.youtubeTranscript && !attachments.some((attachment) => attachment.kind === 'youtube-transcript')) {
		attachments.push(youtubeTranscriptAttachment(draft.youtubeTranscript));
	}
	if (draft.twitterSourceEvent && !attachments.some((attachment) => attachment.kind === 'twitter-source-event')) {
		attachments.push(twitterSourceEventAttachment(draft.twitterSourceEvent));
	}
	return {
		article: draft.article,
		...(attachments.length ? { attachments } : {}),
	};
}

async function createSourceArticleDraftRef(env: Env, draft: SourceArticleDraft): Promise<SourceArticleDraftRef> {
	const normalizedDraft = normalizeSourceArticleDraft(draft);
	const serialized = JSON.stringify(normalizedDraft);
	const url = draft.article.url;
	return new TextEncoder().encode(serialized).byteLength <= MAX_INLINE_SOURCE_ARTICLE_BYTES
		? { url, inline: normalizedDraft }
		: writeSourceArticleDraft(env, url, serialized);
}

async function writeSourceArticleDraft(env: Env, url: string, serialized: string): Promise<SourceArticleDraftRef> {
	const r2Key = await putRandomSerializedTempJson(env, SOURCE_ARTICLE_DRAFT_PREFIX, serialized);
	return { url, r2Key };
}

export function sourceArticleDraftUrl(ref: SourceArticleDraftRef): string {
	return ref.url;
}

function sourceArticleDraftR2Key(ref: SourceArticleDraftRef): string | null {
	return 'r2Key' in ref ? ref.r2Key : null;
}

export function sourceArticleDraftHasTempObject(ref: SourceArticleDraftRef): boolean {
	return sourceArticleDraftR2Key(ref) !== null;
}

export async function readSourceArticleDraft(env: Env, ref: SourceArticleDraftRef): Promise<SourceArticleDraft> {
	if ('inline' in ref) return normalizeSourceArticleDraft(ref.inline as LegacySourceArticleDraft);
	return normalizeSourceArticleDraft(
		await readTempJson<LegacySourceArticleDraft>(env, ref.r2Key, { prefix: SOURCE_ARTICLE_DRAFT_PREFIX, label: 'source article draft' }),
	);
}

export function sourceDraftToArticle(draft: SourceArticleDraft): Article {
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
}

export async function deleteSourceArticleDraft(env: Env, ref: SourceArticleDraftRef): Promise<void> {
	const r2Key = sourceArticleDraftR2Key(ref);
	if (!r2Key) return;
	await deleteTempObject(env, r2Key, { prefix: SOURCE_ARTICLE_DRAFT_PREFIX, label: 'source article draft' });
}

export async function ensureWorkflowsForQueueMessage(
	env: Env,
	messageId: string,
	body: QueueMessage,
): Promise<{ count: number; created: number; existing: number }> {
	const result = await ensureWorkflowForQueueTarget(env, messageId, body.target);
	return { count: 1, created: result.created ? 1 : 0, existing: result.created ? 0 : 1 };
}

async function ensureWorkflowForQueueTarget(
	env: Env,
	messageId: string,
	target: WorkflowQueueTarget,
): Promise<{ id: string; created: boolean }> {
	if (target.kind === 'source') {
		const workflowId = await sourceArticleWorkflowId(sourceArticleDraftUrl(target.sourceArticle));
		const result = await ensureSourceArticleWorkflow(env, workflowId, messageId, target.sourceArticle);
		if (!result.sourceRefUsed) await cleanupUnusedSourceArticleDraft(env, target.sourceArticle, result.id);
		return { id: result.id, created: result.created };
	}

	const targetTable = resolveProcessableTable(target.targetTable);
	const workflowId = articleWorkflowId(messageId, targetTable, target.articleId);
	return ensureArticleWorkflow(env, workflowId, target.articleId, targetTable);
}

function articleWorkflowId(messageId: string, targetTable: ProcessableTable, articleId: string): string {
	return ['article', workflowIdPart(messageId), workflowIdPart(targetTable), workflowIdPart(articleId)].join('-');
}

function workflowIdPart(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
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

async function ensureSourceArticleWorkflow(
	env: Env,
	workflowId: string,
	messageId: string,
	sourceArticle: SourceArticleDraftRef,
): Promise<{ id: string; created: boolean; sourceRefUsed: boolean }> {
	const existing = await getMonitorWorkflowStatus(env, workflowId);
	if (isReusableSourceWorkflowStatus(existing.status)) return { id: existing.id, created: false, sourceRefUsed: false };

	try {
		const id = await createMonitorWorkflow(env, workflowId, { kind: 'source', sourceArticle });
		return { id, created: true, sourceRefUsed: true };
	} catch {
		const raced = await getMonitorWorkflowStatus(env, workflowId);
		if (raced.status !== 'unknown') return { id: raced.id, created: false, sourceRefUsed: false };
	}

	const retryWorkflowId = `${workflowId}-${workflowIdPart(messageId)}`;
	const existingRetry = await getMonitorWorkflowStatus(env, retryWorkflowId);
	if (existingRetry.status !== 'unknown') return { id: existingRetry.id, created: false, sourceRefUsed: true };

	try {
		const id = await createMonitorWorkflow(env, retryWorkflowId, { kind: 'source', sourceArticle });
		return { id, created: true, sourceRefUsed: true };
	} catch (err) {
		const raced = await getMonitorWorkflowStatus(env, retryWorkflowId);
		if (raced.status !== 'unknown') return { id: raced.id, created: false, sourceRefUsed: true };
		throw err;
	}
}

function isReusableSourceWorkflowStatus(status: string): boolean {
	return status === 'complete' || ACTIVE_WORKFLOW_STATUSES.has(status);
}

async function cleanupUnusedSourceArticleDraft(env: Env, sourceArticle: SourceArticleDraftRef, workflowId: string): Promise<void> {
	await cleanupSourceArticleDraftRef(env, sourceArticle, { reason: 'workflow already exists', workflowId });
}

async function cleanupSourceArticleDraftRef(
	env: Env,
	sourceArticle: SourceArticleDraftRef,
	context: { reason: string; workflowId?: string },
): Promise<void> {
	const r2Key = sourceArticleDraftR2Key(sourceArticle);
	if (!r2Key) return;
	try {
		await deleteSourceArticleDraft(env, sourceArticle);
	} catch (err) {
		console.warn({
			tag: 'ARTICLE-QUEUE',
			msg: 'Failed to cleanup source article draft',
			reason: context.reason,
			workflowId: context.workflowId,
			r2Key,
			error: String(err),
		});
	}
}

async function ensureArticleWorkflow(
	env: Env,
	workflowId: string,
	articleId: string,
	targetTable: ProcessableTable,
): Promise<{ id: string; created: boolean }> {
	const existing = await getMonitorWorkflowStatus(env, workflowId);
	if (existing.status !== 'unknown') return { id: existing.id, created: false };

	try {
		const id = await createMonitorWorkflow(env, workflowId, rowWorkflowTarget(articleId, targetTable));
		return { id, created: true };
	} catch (err) {
		const raced = await getMonitorWorkflowStatus(env, workflowId);
		if (raced.status !== 'unknown') return { id: raced.id, created: false };
		throw err;
	}
}

export async function createUserFileWorkflow(env: Env, userFileId: string): Promise<string | undefined> {
	try {
		const storedInstanceId = await withDbClient(env, (db) => getUserFileWorkflowInstanceId(db, userFileId));
		if (storedInstanceId) {
			const stored = await getMonitorWorkflowStatus(env, storedInstanceId);
			if (ACTIVE_WORKFLOW_STATUSES.has(stored.status)) return stored.id;
		}

		const baseId = userFileWorkflowId(userFileId);
		const workflowId = storedInstanceId ? `${baseId}-${crypto.randomUUID()}` : baseId;
		const instanceId = await createUserFileWorkflowInstance(env, workflowId, userFileId);
		await withDbClient(env, (db) => recordUserFileWorkflowInstanceId(db, userFileId, instanceId));
		return instanceId;
	} catch (err) {
		console.error({ tag: 'WORKFLOW', msg: 'create failed', userFileId, error: String(err) });
		return undefined;
	}
}

function userFileWorkflowId(userFileId: string): string {
	return `user-file-${userFileId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80)}`;
}

async function createUserFileWorkflowInstance(env: Env, workflowId: string, userFileId: string): Promise<string> {
	try {
		return createMonitorWorkflow(env, workflowId, rowWorkflowTarget(userFileId, USER_FILES_TABLE));
	} catch (err) {
		const existing = await getMonitorWorkflowStatus(env, workflowId);
		if (ACTIVE_WORKFLOW_STATUSES.has(existing.status)) return existing.id;
		if (existing.status === 'unknown') throw err;

		return createMonitorWorkflow(env, `${workflowId}-${crypto.randomUUID()}`, rowWorkflowTarget(userFileId, USER_FILES_TABLE));
	}
}

async function getMonitorWorkflowStatus(env: Env, workflowId: string): Promise<{ id: string; status: string }> {
	const instance = await env.MONITOR_WORKFLOW.get(workflowId);
	const status = await instance.status();
	return { id: instance.id, status: status.status };
}

async function createMonitorWorkflow(env: Env, workflowId: string, target: WorkflowQueueTarget): Promise<string> {
	const instance = await env.MONITOR_WORKFLOW.create({
		id: workflowId,
		params: { target },
	});
	return instance.id;
}
