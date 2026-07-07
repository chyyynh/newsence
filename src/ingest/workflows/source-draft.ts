import type { InsertArticleData } from '@core-shared/article-store';
import type { TwitterMedia } from '@core-shared/platform-metadata';
import type { Env, Tweet } from '@core-shared/types';
import type { YoutubeTranscriptRow } from '@ingest/platforms/youtube/transcripts';

type TwitterSourceEventType = 'tweet' | 'thread' | 'share' | 'quote' | 'retweet' | 'article';

export type TwitterSourceEventDraft = {
	tweet: Tweet;
	eventType: TwitterSourceEventType;
	text?: string | null;
	media?: TwitterMedia[];
	raw?: unknown;
};

type SourceArticleAttachment =
	| { kind: 'youtube-transcript'; transcript: YoutubeTranscriptRow }
	| { kind: 'twitter-source-event'; event: TwitterSourceEventDraft };

export interface SourceArticleDraft {
	article: InsertArticleData;
	attachments?: SourceArticleAttachment[];
}

export type SourceArticleDraftRef = { url: string; r2Key: string };

const SOURCE_ARTICLE_DRAFT_PREFIX = 'tmp/workflow/source-articles/';
const SOURCE_ARTICLE_DRAFT_CONTENT_TYPE = 'application/json; charset=utf-8';

export async function createSourceArticleDraftRef(env: Env, draft: SourceArticleDraft): Promise<SourceArticleDraftRef> {
	const r2Key = `${SOURCE_ARTICLE_DRAFT_PREFIX}${crypto.randomUUID()}.json`;
	await env.R2.put(r2Key, JSON.stringify(draft), { httpMetadata: { contentType: SOURCE_ARTICLE_DRAFT_CONTENT_TYPE } });
	return { url: draft.article.url, r2Key };
}

export async function readSourceArticleDraft(env: Env, ref: SourceArticleDraftRef): Promise<SourceArticleDraft> {
	if (!ref.r2Key.startsWith(SOURCE_ARTICLE_DRAFT_PREFIX)) throw new Error(`Invalid source article draft key: ${ref.r2Key}`);
	const obj = await env.R2.get(ref.r2Key);
	if (!obj) throw new Error(`source article draft missing: ${ref.r2Key}`);
	return obj.json<SourceArticleDraft>();
}

export async function cleanupSourceArticleDraftRef(
	env: Env,
	ref: SourceArticleDraftRef,
	context: { reason: string; workflowId?: string; logTag?: string },
): Promise<void> {
	try {
		if (!ref.r2Key.startsWith(SOURCE_ARTICLE_DRAFT_PREFIX)) throw new Error(`Invalid source article draft key: ${ref.r2Key}`);
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
