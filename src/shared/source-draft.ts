import type { InsertArticleData } from './article-store';
import type { TwitterMedia } from './platform-metadata';
import { deleteTempObject, putRandomSerializedTempJson, readTempJson } from './r2-temp';
import type { Article, Env, Tweet } from './types';
import type { YoutubeTranscriptRow } from './youtube-transcripts';

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

export type SourceArticleDraftRef = { url: string; r2Key: string };

const SOURCE_ARTICLE_DRAFT_PREFIX = 'tmp/workflow/source-articles/';

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

export async function createSourceArticleDraftRef(env: Env, draft: SourceArticleDraft): Promise<SourceArticleDraftRef> {
	const normalizedDraft = normalizeSourceArticleDraft(draft);
	const serialized = JSON.stringify(normalizedDraft);
	return writeSourceArticleDraft(env, draft.article.url, serialized);
}

async function writeSourceArticleDraft(env: Env, url: string, serialized: string): Promise<SourceArticleDraftRef> {
	const r2Key = await putRandomSerializedTempJson(env, SOURCE_ARTICLE_DRAFT_PREFIX, serialized);
	return { url, r2Key };
}

export function sourceArticleDraftUrl(ref: SourceArticleDraftRef): string {
	return ref.url;
}

export function isSourceArticleDraftRef(ref: unknown): ref is SourceArticleDraftRef {
	if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return false;
	const candidate = ref as Partial<Record<keyof SourceArticleDraftRef, unknown>>;
	return (
		typeof candidate.url === 'string' &&
		candidate.url.length > 0 &&
		typeof candidate.r2Key === 'string' &&
		candidate.r2Key.startsWith(SOURCE_ARTICLE_DRAFT_PREFIX)
	);
}

export async function readSourceArticleDraft(env: Env, ref: SourceArticleDraftRef): Promise<SourceArticleDraft> {
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

async function deleteSourceArticleDraft(env: Env, ref: SourceArticleDraftRef): Promise<void> {
	await deleteTempObject(env, ref.r2Key, { prefix: SOURCE_ARTICLE_DRAFT_PREFIX, label: 'source article draft' });
}

export async function cleanupSourceArticleDraftRef(
	env: Env,
	ref: SourceArticleDraftRef,
	context: { reason: string; workflowId?: string; logTag?: string },
): Promise<void> {
	try {
		await deleteSourceArticleDraft(env, ref);
	} catch (err) {
		console.warn({
			tag: context.logTag ?? 'SOURCE-DRAFT',
			msg: 'Failed to cleanup source article draft',
			reason: context.reason,
			workflowId: context.workflowId,
			sourceUrl: sourceArticleDraftUrl(ref),
			error: String(err),
		});
	}
}
