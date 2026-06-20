import type { DbClient } from './db';

export interface YoutubeTranscriptRow {
	videoId: string;
	segments: unknown[];
	language: string | null;
	chapters?: unknown;
	chaptersFromDescription?: unknown;
}

export interface YoutubeTranscriptForHighlights {
	transcript: Array<{ startTime: number; endTime: number; text: string }> | null;
	ai_highlights: unknown;
}

export interface YoutubeHighlightsUpdateData {
	videoId: string;
	value: unknown;
	generatedAt: string;
}

export async function upsertYoutubeTranscript(db: DbClient, transcript: YoutubeTranscriptRow): Promise<void> {
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
			transcript.videoId,
			JSON.stringify(transcript.segments),
			transcript.language,
			transcript.chapters ? JSON.stringify(transcript.chapters) : null,
			transcript.chaptersFromDescription ?? null,
			new Date(),
		],
	);
}

export async function getYoutubeTranscriptForHighlights(db: DbClient, videoId: string): Promise<YoutubeTranscriptForHighlights | null> {
	const result = await db.query<YoutubeTranscriptForHighlights>(
		'SELECT transcript, ai_highlights FROM youtube_transcripts WHERE video_id = $1',
		[videoId],
	);
	return result.rows[0] ?? null;
}

export async function saveYouTubeHighlights(db: DbClient, update: YoutubeHighlightsUpdateData): Promise<void> {
	await db.query('UPDATE youtube_transcripts SET ai_highlights = $1, highlights_generated_at = $2 WHERE video_id = $3', [
		JSON.stringify(update.value),
		update.generatedAt,
		update.videoId,
	]);
}
