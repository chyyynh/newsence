import { CORE_JSON_MODEL, generateObject } from '@core-ai/generation';
import { platformMetadataFor, type ResourceForProcessing, type TranscriptSegment, type YoutubeTranscript } from '@core-shared/types';
import { type CoreDb, withCoreDb } from '@db/client';
import { youtubeTranscripts } from '@db/schema';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';

// Enrichment only. Channel discovery is the feed monitor's job: a channel handle
// is its Atom feed URL, so channels stay platform='youtube' with content_mode
// 'web' and are polled by handleRSSCron, and scrapeSavedUrl routes the resulting
// watch?v= links back to YouTube.

const YouTubeHighlightSchema = z.object({
	title: z.string().min(1),
	summary: z.string().min(1),
	startTime: z.number().nonnegative(),
	endTime: z.number().nonnegative(),
});

type YouTubeHighlight = z.infer<typeof YouTubeHighlightSchema>;

export interface YouTubeHighlightsUpdate {
	videoId: string;
	value: {
		version: '1.0';
		model: string;
		highlights: YouTubeHighlight[];
		generatedAt: string;
	};
}

const HIGHLIGHTS_SYSTEM_PROMPT = `你是專業的影片內容分析師。分析 YouTube 影片逐字稿，找出 5-8 個最重要的主題段落。

規則：
1. 每個段落代表一個獨立主題
2. 段落之間不重疊
3. 標題要精簡有力（30字內）
4. 時間戳記要準確對應討論內容的起止
5. 所有文字使用繁體中文

只回傳符合 schema 的資料。`;

const YouTubeHighlightsSchema = z.object({
	highlights: z.array(YouTubeHighlightSchema).min(1),
});

export async function persistYouTubeWorkflowData(
	db: CoreDb,
	input: { transcript?: YoutubeTranscript | null; highlights?: YouTubeHighlightsUpdate | null },
): Promise<void> {
	if (input.transcript) {
		await db
			.insert(youtubeTranscripts)
			.values({
				videoId: input.transcript.videoId,
				transcript: input.transcript.segments,
				language: input.transcript.language,
				chapters: input.transcript.chapters,
				chaptersFromDescription: input.transcript.chaptersFromDescription,
				fetchedAt: new Date(),
			})
			.onConflictDoUpdate({
				target: youtubeTranscripts.videoId,
				set: {
					transcript: sql`excluded.transcript`,
					language: sql`excluded.language`,
					chapters: sql`excluded.chapters`,
					chaptersFromDescription: sql`excluded.chapters_from_description`,
					fetchedAt: sql`excluded.fetched_at`,
				},
			});
	}
	if (input.highlights) {
		await db
			.update(youtubeTranscripts)
			.set({ aiHighlights: input.highlights.value, highlightsGeneratedAt: new Date(input.highlights.value.generatedAt) })
			.where(eq(youtubeTranscripts.videoId, input.highlights.videoId));
	}
}

export async function prepareYouTubeHighlights(
	env: CoreEnv,
	resource: ResourceForProcessing,
	transcript?: YoutubeTranscript | null,
): Promise<YouTubeHighlightsUpdate | null> {
	if (resource.type !== 'youtube') return null;
	const metadata = platformMetadataFor(resource, 'youtube');
	if (!metadata) return null;

	const videoId = metadata.data.videoId;
	if (!videoId) return null;
	if (transcript) {
		return transcript.segments.length ? prepareYouTubeHighlightsFromTranscript(env, videoId, transcript.segments) : null;
	}

	const row = await withCoreDb(
		env,
		async (db) =>
			(
				await db
					.select({ transcript: youtubeTranscripts.transcript, aiHighlights: youtubeTranscripts.aiHighlights })
					.from(youtubeTranscripts)
					.where(eq(youtubeTranscripts.videoId, videoId))
					.limit(1)
			)[0],
	);
	if (!row || row.aiHighlights || !Array.isArray(row.transcript) || row.transcript.length === 0) return null;

	return prepareYouTubeHighlightsFromTranscript(env, videoId, row.transcript);
}

async function prepareYouTubeHighlightsFromTranscript(
	env: CoreEnv,
	videoId: string,
	transcript: TranscriptSegment[],
): Promise<YouTubeHighlightsUpdate | null> {
	console.info({ tag: 'AI', msg: 'Generating YouTube highlights', videoId });

	const transcriptText = transcript.map((s) => `[${Math.floor(s.startTime)}s] ${s.text}`).join('\n');
	const last = transcript[transcript.length - 1];
	const duration = Math.ceil(last.endTime);

	const highlights = await generateObject(env.AI, `影片總長度：${duration} 秒\n\n逐字稿：\n${transcriptText}`, {
		schema: YouTubeHighlightsSchema,
		task: 'youtube-highlights',
		gatewayId: env.AI_GATEWAY_NAME,
		maxTokens: 2000,
		temperature: 0.3,
		systemPrompt: HIGHLIGHTS_SYSTEM_PROMPT,
	});

	if (!highlights?.highlights.length) {
		throw new Error(`YouTube highlights did not return valid output for ${videoId}`);
	}

	console.info({ tag: 'AI', msg: 'YouTube highlights generated', videoId, count: highlights.highlights.length });
	const generatedAt = new Date().toISOString();
	return {
		videoId,
		value: {
			version: '1.0',
			model: CORE_JSON_MODEL,
			highlights: highlights.highlights,
			generatedAt,
		},
	};
}
