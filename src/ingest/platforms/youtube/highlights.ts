// ─────────────────────────────────────────────────────────────
// YouTube Highlights Generator
// ─────────────────────────────────────────────────────────────

import { generateJson } from '@shared/ai';
import type { Env } from '@shared/types';
import type { TranscriptSegment } from '@shared/web';

export interface YouTubeHighlight {
	title: string;
	summary: string;
	startTime: number;
	endTime: number;
}

export interface YouTubeHighlightsResult {
	highlights: YouTubeHighlight[];
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

export async function generateYouTubeHighlights(
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
