import { writeFileSync } from 'fs';
import { join } from 'path';

interface SubtitleSegment {
	startTime: number;
	endTime: number;
	text: string;
	translation?: string;
}

/**
 * Format seconds to ASS timestamp: H:MM:SS.cc (centiseconds)
 */
function formatAssTime(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	const cs = Math.round((seconds % 1) * 100);
	return String(h) + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
}

const ASS_HEADER = `[Script Info]
Title: Clip Subtitles
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans TC,44,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,4,2,0,2,20,20,50,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

/**
 * Generate an ASS subtitle file from segments.
 * Timestamps are normalized relative to startTime (so clip starts at 0:00:00.00).
 * Bilingual format: original text + translation separated by \\N (ASS newline).
 */
export function generateAss(segments: SubtitleSegment[], clipStartTime: number, workDir: string): string {
	const events: string[] = [];

	for (const seg of segments) {
		const relStart = Math.max(0, seg.startTime - clipStartTime);
		const relEnd = Math.max(relStart, seg.endTime - clipStartTime);
		const start = formatAssTime(relStart);
		const end = formatAssTime(relEnd);

		// Bilingual: original \N translation
		const text = seg.translation ? `${seg.text}\\N${seg.translation}` : seg.text;

		events.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${text}`);
	}

	const assContent = ASS_HEADER + events.join('\n') + '\n';
	const assPath = join(workDir, 'subs.ass');
	writeFileSync(assPath, assContent, 'utf-8');
	console.log(`[subtitle] Generated ASS with ${segments.length} segments`);
	return assPath;
}
