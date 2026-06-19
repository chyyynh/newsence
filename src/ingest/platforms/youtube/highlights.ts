import { CORE_TEXT_MODEL, generateJson } from '@shared/ai';
import { type DbClient, withDbClient } from '@shared/db';
import type { Article, Env } from '@shared/types';
import type { TranscriptSegment } from '@shared/web';

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

回傳 JSON 格式：
{
  "highlights": [
    { "title": "段落標題", "summary": "1-2句摘要", "startTime": 0, "endTime": 60 }
  ]
}

只回傳 JSON，不要其他文字。`;

const YOUTUBE_HIGHLIGHTS_SCHEMA = {
	type: 'object',
	properties: {
		highlights: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					title: { type: 'string' },
					summary: { type: 'string' },
					startTime: { type: 'number' },
					endTime: { type: 'number' },
				},
				required: ['title', 'summary', 'startTime', 'endTime'],
			},
		},
	},
	required: ['highlights'],
};

async function generateYouTubeHighlights(
	videoId: string,
	transcript: TranscriptSegment[],
	ai: Env['AI'],
): Promise<YouTubeHighlightsResult | null> {
	console.info({ tag: 'AI', msg: 'Generating YouTube highlights', videoId });

	const transcriptText = transcript.map((s) => `[${Math.floor(s.startTime)}s] ${s.text}`).join('\n');
	const last = transcript[transcript.length - 1];
	const duration = Math.ceil(last.endTime);

	const result = await generateJson<YouTubeHighlightsResult>(ai, `影片總長度：${duration} 秒\n\n逐字稿：\n${transcriptText}`, {
		schema: YOUTUBE_HIGHLIGHTS_SCHEMA,
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
		const result = await db.query<{
			transcript: Array<{ startTime: number; endTime: number; text: string }> | null;
			ai_highlights: unknown;
		}>('SELECT transcript, ai_highlights FROM youtube_transcripts WHERE video_id = $1', [videoId]);
		const row = result.rows[0];
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

export async function saveYouTubeHighlights(db: DbClient, update: YouTubeHighlightsUpdate): Promise<void> {
	await db.query('UPDATE youtube_transcripts SET ai_highlights = $1, highlights_generated_at = $2 WHERE video_id = $3', [
		JSON.stringify(update.value),
		update.generatedAt,
		update.videoId,
	]);
}
