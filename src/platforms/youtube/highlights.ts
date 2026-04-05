// ─────────────────────────────────────────────────────────────
// YouTube Highlights Generator
// ─────────────────────────────────────────────────────────────

import { logError, logInfo } from '../../infra/log';
import { AI_MODELS, callOpenRouter, extractJson } from '../../infra/openrouter';
import type { TranscriptSegment } from '../../models/scraped-content';

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

export async function generateYouTubeHighlights(
	videoId: string,
	transcript: TranscriptSegment[],
	apiKey: string,
): Promise<YouTubeHighlightsResult | null> {
	logInfo('AI', 'Generating YouTube highlights', { videoId });

	const transcriptText = transcript.map((s) => `[${Math.floor(s.startTime)}s] ${s.text}`).join('\n');
	const last = transcript[transcript.length - 1];
	const duration = Math.ceil(last.endTime);

	const rawContent = await callOpenRouter(`影片總長度：${duration} 秒\n\n逐字稿：\n${transcriptText}`, {
		apiKey,
		model: AI_MODELS.FLASH,
		maxTokens: 2000,
		temperature: 0.3,
		systemPrompt: HIGHLIGHTS_SYSTEM_PROMPT,
	});

	if (!rawContent) {
		logError('AI', 'YouTube highlights: empty response', { videoId });
		return null;
	}

	const result = extractJson<YouTubeHighlightsResult>(rawContent);
	if (!result?.highlights || !Array.isArray(result.highlights) || result.highlights.length === 0) {
		logError('AI', 'YouTube highlights: invalid JSON', { videoId });
		return null;
	}

	logInfo('AI', 'YouTube highlights generated', { videoId, count: result.highlights.length });
	return result;
}
