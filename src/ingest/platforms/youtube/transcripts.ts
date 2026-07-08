import { CORE_JSON_MODEL, generateObject } from '@core-ai/embedding';
import type { Article, TranscriptSegment, YoutubeTranscript } from '@core-shared/types';
import { Client } from 'pg';
import { z } from 'zod';

const YouTubeHighlightSchema = z.object({
	title: z.string().min(1),
	summary: z.string().min(1),
	startTime: z.number().nonnegative(),
	endTime: z.number().nonnegative(),
});

type YouTubeHighlight = z.infer<typeof YouTubeHighlightSchema>;

interface YouTubeHighlightsUpdate {
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
	db: Client,
	input: { transcript?: YoutubeTranscript | null; highlights?: YouTubeHighlightsUpdate | null },
): Promise<void> {
	if (input.transcript) {
		await db.query(
			`INSERT INTO youtube_transcripts (video_id, transcript, language, chapters, chapters_from_description, fetched_at)
			VALUES ($1, $2, $3, $4, $5, $6)
			ON CONFLICT (video_id) DO UPDATE SET
				transcript = EXCLUDED.transcript,
				language = EXCLUDED.language,
				chapters = EXCLUDED.chapters,
				chapters_from_description = EXCLUDED.chapters_from_description,
				fetched_at = EXCLUDED.fetched_at`,
			[
				input.transcript.videoId,
				JSON.stringify(input.transcript.segments),
				input.transcript.language,
				input.transcript.chapters ? JSON.stringify(input.transcript.chapters) : null,
				input.transcript.chaptersFromDescription ?? null,
				new Date(),
			],
		);
	}
	if (input.highlights) {
		await db.query('UPDATE youtube_transcripts SET ai_highlights = $1, highlights_generated_at = $2 WHERE video_id = $3', [
			JSON.stringify(input.highlights.value),
			input.highlights.value.generatedAt,
			input.highlights.videoId,
		]);
	}
}

export async function prepareYouTubeHighlights(
	env: Env,
	article: Article,
	transcript?: YoutubeTranscript | null,
): Promise<YouTubeHighlightsUpdate | null> {
	if (article.platform_metadata?.type !== 'youtube') return null;

	const videoId = article.platform_metadata.data.videoId;
	if (!videoId) return null;
	if (transcript) return prepareYouTubeHighlightsFromTranscript(env, videoId, transcript.segments);

	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	const row = (
		await db.query<{ transcript: TranscriptSegment[] | null; ai_highlights: unknown }>(
			'SELECT transcript, ai_highlights FROM youtube_transcripts WHERE video_id = $1',
			[videoId],
		)
	).rows[0];
	if (!row || row.ai_highlights || !Array.isArray(row.transcript) || row.transcript.length === 0) return null;

	return prepareYouTubeHighlightsFromTranscript(env, videoId, row.transcript);
}

async function prepareYouTubeHighlightsFromTranscript(
	env: Env,
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
		console.error({ tag: 'AI', msg: 'YouTube highlights: invalid JSON', videoId });
		return null;
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
