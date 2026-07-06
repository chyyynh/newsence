import type { InsertArticleData } from '@core-shared/article-store';
import type { TwitterMedia } from '@core-shared/platform-metadata';
import type { Article, Env, Tweet } from '@core-shared/types';
import type { YoutubeTranscriptRow } from '@ingest/platforms/youtube/transcripts';

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
const SOURCE_ARTICLE_DRAFT_CONTENT_TYPE = 'application/json; charset=utf-8';

function assertSourceArticleDraftKey(key: string): void {
	if (!key.startsWith(SOURCE_ARTICLE_DRAFT_PREFIX)) throw new Error(`Invalid source article draft key: ${key}`);
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

export async function createSourceArticleDraftRef(env: Env, draft: SourceArticleDraft): Promise<SourceArticleDraftRef> {
	const normalizedDraft = normalizeSourceArticleDraft(draft);
	const r2Key = `${SOURCE_ARTICLE_DRAFT_PREFIX}${crypto.randomUUID()}.json`;
	await env.R2.put(r2Key, JSON.stringify(normalizedDraft), { httpMetadata: { contentType: SOURCE_ARTICLE_DRAFT_CONTENT_TYPE } });
	return { url: draft.article.url, r2Key };
}

export async function readSourceArticleDraft(env: Env, ref: SourceArticleDraftRef): Promise<SourceArticleDraft> {
	assertSourceArticleDraftKey(ref.r2Key);
	const obj = await env.R2.get(ref.r2Key);
	if (!obj) throw new Error(`source article draft missing: ${ref.r2Key}`);
	return normalizeSourceArticleDraft(await obj.json<LegacySourceArticleDraft>());
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

export async function cleanupSourceArticleDraftRef(
	env: Env,
	ref: SourceArticleDraftRef,
	context: { reason: string; workflowId?: string; logTag?: string },
): Promise<void> {
	try {
		assertSourceArticleDraftKey(ref.r2Key);
		await env.R2.delete(ref.r2Key);
	} catch (err) {
		console.warn({
			tag: context.logTag ?? 'SOURCE-DRAFT',
			msg: 'Failed to cleanup source article draft',
			reason: context.reason,
			workflowId: context.workflowId,
			sourceUrl: ref.url,
			error: String(err),
		});
	}
}
