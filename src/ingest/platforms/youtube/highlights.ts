import { AI_TASKS, CORE_TEXT_MODEL, generateObject } from '@shared/ai';
import { withDbClient } from '@shared/db';
import type { Article, Env } from '@shared/types';
import type { TranscriptSegment } from '@shared/web';
import { getYoutubeTranscriptForHighlights } from '@shared/youtube-transcripts';
import { z } from 'zod';

interface YouTubeHighlight {
	title: string;
	summary: string;
	startTime: number;
	endTime: number;
}

interface YouTubeHighlightsResult {
	highlights: YouTubeHighlight[];
}

export interface YouTubeHighlightsUpdate {
	videoId: string;
	value: {
		version: '1.0';
		model: string;
		highlights: YouTubeHighlight[];
		generatedAt: string;
	};
	generatedAt: string;
	count: number;
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
	highlights: z
		.array(
			z.object({
				title: z.string().min(1),
				summary: z.string().min(1),
				startTime: z.number().nonnegative(),
				endTime: z.number().nonnegative(),
			}),
		)
		.min(1),
});

async function generateYouTubeHighlights(
	videoId: string,
	transcript: TranscriptSegment[],
	ai: Env['AI'],
): Promise<YouTubeHighlightsResult | null> {
	console.info({ tag: 'AI', msg: 'Generating YouTube highlights', videoId });

	const transcriptText = transcript.map((s) => `[${Math.floor(s.startTime)}s] ${s.text}`).join('\n');
	const last = transcript[transcript.length - 1];
	const duration = Math.ceil(last.endTime);

	const result = await generateObject<YouTubeHighlightsResult>(ai, `影片總長度：${duration} 秒\n\n逐字稿：\n${transcriptText}`, {
		schema: YouTubeHighlightsSchema,
		schemaName: 'youtube highlights',
		task: AI_TASKS.youtubeHighlights,
		maxTokens: 2000,
		temperature: 0.3,
		systemPrompt: HIGHLIGHTS_SYSTEM_PROMPT,
	});

	if (!result?.highlights || !Array.isArray(result.highlights) || result.highlights.length === 0) {
		console.error({ tag: 'AI', msg: 'YouTube highlights: invalid JSON', videoId });
		return null;
	}

	console.info({ tag: 'AI', msg: 'YouTube highlights generated', videoId, count: result.highlights.length });
	return result;
}

export async function prepareYouTubeHighlights(env: Env, article: Article): Promise<YouTubeHighlightsUpdate | null> {
	if (article.platform_metadata?.type !== 'youtube') return null;

	const videoId = article.platform_metadata.data.videoId;
	if (!videoId) return null;

	return withDbClient(env, async (db) => {
		const row = await getYoutubeTranscriptForHighlights(db, videoId);
		if (!row || row.ai_highlights || !Array.isArray(row.transcript) || row.transcript.length === 0) return null;

		return prepareYouTubeHighlightsFromTranscript(env, videoId, row.transcript);
	});
}

export async function prepareYouTubeHighlightsFromTranscript(
	env: Env,
	videoId: string,
	transcript: TranscriptSegment[],
): Promise<YouTubeHighlightsUpdate | null> {
	const highlights = await generateYouTubeHighlights(videoId, transcript, env.AI);
	if (!highlights) return null;

	const generatedAt = new Date().toISOString();
	return {
		videoId,
		value: {
			version: '1.0',
			model: CORE_TEXT_MODEL,
			highlights: highlights.highlights,
			generatedAt,
		},
		generatedAt,
		count: highlights.highlights.length,
	};
}
