export interface YoutubeTranscriptRow {
	videoId: string;
	segments: unknown[];
	language: string | null;
	chapters?: unknown;
	chaptersFromDescription?: unknown;
}
