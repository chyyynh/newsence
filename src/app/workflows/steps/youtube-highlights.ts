import { generateYouTubeHighlights } from '../../../domain/processing/processors';
import { createDbClient } from '../../../infra/db';
import { logInfo } from '../../../infra/log';
import type { Article, Env } from '../../../models/types';

export async function generateAndSaveYouTubeHighlights(env: Env, articleId: string, article: Article): Promise<void> {
	if (article.platform_metadata?.type !== 'youtube') return;

	const videoId = article.platform_metadata.data.videoId;
	if (!videoId) return;

	const db = await createDbClient(env);
	try {
		const result = await db.query<{
			transcript: Array<{ startTime: number; endTime: number; text: string }> | null;
			ai_highlights: unknown;
		}>('SELECT transcript, ai_highlights FROM youtube_transcripts WHERE video_id = $1', [videoId]);
		const row = result.rows[0];
		if (!row || row.ai_highlights || !Array.isArray(row.transcript) || row.transcript.length === 0) return;

		const highlights = await generateYouTubeHighlights(videoId, row.transcript, env.OPENROUTER_API_KEY);
		if (!highlights) return;

		const generatedAt = new Date().toISOString();
		const aiHighlights = {
			version: '1.0',
			model: 'google/gemini-3-flash-preview',
			highlights: highlights.highlights,
			generatedAt,
		};
		await db.query('UPDATE youtube_transcripts SET ai_highlights = $1, highlights_generated_at = $2 WHERE video_id = $3', [
			JSON.stringify(aiHighlights),
			generatedAt,
			videoId,
		]);
		logInfo('WORKFLOW', 'YouTube highlights saved', { article_id: articleId, videoId, count: highlights.highlights.length });
	} finally {
		await db.end();
	}
}
