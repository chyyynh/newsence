// ─────────────────────────────────────────────────────────────
// YouTube Scraper
// ─────────────────────────────────────────────────────────────

import type { YouTubeMetadata } from '@shared/platform-metadata';
import { fetchWithTimeout, readTextWithLimit, type ScrapedContent, type TranscriptSegment, type YouTubeChapter } from '@shared/web';

interface YouTubeVideoItem {
	id: string;
	snippet: {
		title: string;
		description: string;
		channelId: string;
		channelTitle: string;
		publishedAt: string;
		thumbnails: {
			default?: { url: string };
			medium?: { url: string };
			high?: { url: string };
			standard?: { url: string };
			maxres?: { url: string };
		};
		tags?: string[];
	};
	contentDetails: {
		duration: string;
	};
	statistics: {
		viewCount?: string;
		likeCount?: string;
		commentCount?: string;
	};
}

type YouTubeScrapeOptions = {
	minDurationSecondsForTranscript?: number;
};

type YouTubeVideosResponse = {
	items?: YouTubeVideoItem[];
	error?: { message: string };
};

function parseChaptersFromDescription(description: string): YouTubeChapter[] {
	const chapterRegex = /(?:^|\n)(\d{1,2}:)?(\d{1,2}):(\d{2})\s+(.+?)(?=\n|$)/g;
	const chapters: YouTubeChapter[] = [];

	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex.exec loop
	while ((match = chapterRegex.exec(description)) !== null) {
		const hours = match[1] ? parseInt(match[1].replace(':', ''), 10) : 0;
		const minutes = parseInt(match[2], 10);
		const seconds = parseInt(match[3], 10);
		const title = match[4].trim();

		if (title.length < 2 || /^\d+:\d+/.test(title)) continue;

		const startTime = hours * 3600 + minutes * 60 + seconds;
		chapters.push({ title, startTime, endTime: 0 });
	}

	for (let i = 0; i < chapters.length; i++) {
		chapters[i].endTime = chapters[i + 1]?.startTime ?? Number.MAX_SAFE_INTEGER;
	}

	return chapters.length >= 2 ? chapters : [];
}

const EMPTY_TRANSCRIPT: { segments: TranscriptSegment[]; language: string | null } = { segments: [], language: null };
const TRANSCRIPT_FETCH_TIMEOUT_MS = 8_000;
const YOUTUBE_API_TIMEOUT_MS = 15_000;
const YOUTUBE_API_MAX_BYTES = 1024 * 1024;

const transcriptFetch: typeof fetch = (input, init) => {
	const url = typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
	return fetchWithTimeout(url, init, TRANSCRIPT_FETCH_TIMEOUT_MS);
};

function toSeconds(value: string | number | undefined): number {
	if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
	if (!value) return 0;
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function parseDurationSeconds(iso: string | undefined): number {
	if (!iso) return 0;
	const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
	if (!match) return 0;
	return parseInt(match[1] || '0', 10) * 3600 + parseInt(match[2] || '0', 10) * 60 + parseInt(match[3] || '0', 10);
}

function redactSecret(message: string, secret: string): string {
	return secret ? message.replaceAll(secret, '[redacted]') : message;
}

function transcriptToMarkdown(segments: TranscriptSegment[]): string {
	return segments
		.map((segment) => segment.text.trim())
		.filter(Boolean)
		.join('\n');
}

function buildYouTubeContent(description: string, transcript: TranscriptSegment[]): string {
	const transcriptMarkdown = transcriptToMarkdown(transcript);
	if (transcriptMarkdown) return transcriptMarkdown;
	return description.trim();
}

async function fetchYouTubeVideoData(videoId: string, youtubeApiKey: string): Promise<YouTubeVideosResponse> {
	const url = new URL('https://www.googleapis.com/youtube/v3/videos');
	url.searchParams.set('id', videoId);
	url.searchParams.set('part', 'snippet,contentDetails,statistics');
	url.searchParams.set('key', youtubeApiKey);

	try {
		const response = await fetchWithTimeout(url.toString(), undefined, YOUTUBE_API_TIMEOUT_MS);
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		return JSON.parse(await readTextWithLimit(response, YOUTUBE_API_MAX_BYTES)) as YouTubeVideosResponse;
	} catch (error) {
		throw new Error(`YouTube API request failed for ${videoId}: ${redactSecret(String(error), youtubeApiKey)}`);
	}
}

async function fetchTranscriptViaCaptionExtractor(videoId: string): Promise<{ segments: TranscriptSegment[]; language: string | null }> {
	const { getSubtitles } = await import('youtube-caption-extractor');
	const items = await getSubtitles({ videoID: videoId, fetch: transcriptFetch });

	if (!items?.length) return EMPTY_TRANSCRIPT;

	const segments: TranscriptSegment[] = items.map((item: { start: string; dur: string; text: string }) => {
		const startTime = toSeconds(item.start);
		return {
			startTime,
			endTime: startTime + toSeconds(item.dur),
			text: item.text,
		};
	});

	console.info({ tag: 'YOUTUBE', msg: 'Transcript fetched', provider: 'youtube-caption-extractor', count: segments.length });
	return { segments, language: null };
}

async function fetchTranscriptViaLegacyPackage(videoId: string): Promise<{ segments: TranscriptSegment[]; language: string | null }> {
	const { YoutubeTranscript } = await import('youtube-transcript');
	const items = await YoutubeTranscript.fetchTranscript(videoId, { fetch: transcriptFetch });

	if (!items?.length) return EMPTY_TRANSCRIPT;

	// In Worker environment, the ANDROID InnerTube path usually succeeds while
	// the web page fallback is often blocked by YouTube on datacenter IPs.
	const segments: TranscriptSegment[] = items.map((item: { offset: number; duration: number; text: string }) => ({
		startTime: item.offset / 1000,
		endTime: (item.offset + item.duration) / 1000,
		text: item.text,
	}));

	const language = items[0].lang ?? null;
	console.info({ tag: 'YOUTUBE', msg: 'Transcript fetched', provider: 'youtube-transcript', count: segments.length, language });
	return { segments, language };
}

async function fetchTranscript(videoId: string): Promise<{ segments: TranscriptSegment[]; language: string | null }> {
	console.info({ tag: 'YOUTUBE', msg: 'Fetching transcript', videoId });

	try {
		const first = await fetchTranscriptViaCaptionExtractor(videoId);
		if (first.segments.length > 0) return first;

		console.info({ tag: 'YOUTUBE', msg: 'Transcript provider returned empty', provider: 'youtube-caption-extractor', videoId });
	} catch (error) {
		console.warn({
			tag: 'YOUTUBE',
			msg: 'Transcript provider failed',
			provider: 'youtube-caption-extractor',
			videoId,
			error: String(error),
		});
	}

	return fetchTranscriptViaLegacyPackage(videoId);
}

export async function scrapeYouTube(
	videoId: string,
	youtubeApiKey: string,
	options: YouTubeScrapeOptions = {},
): Promise<ScrapedContent & { metadata: YouTubeMetadata }> {
	console.info({ tag: 'YOUTUBE', msg: 'Fetching video', videoId });

	const videoData = await fetchYouTubeVideoData(videoId, youtubeApiKey);

	if (videoData.error) throw new Error(`YouTube API: ${videoData.error.message}`);
	if (!videoData.items?.length) throw new Error('Video not found');

	const video = videoData.items[0];
	const snippet = video.snippet;
	const stats = video.statistics;

	const thumbnailUrl =
		snippet.thumbnails.maxres?.url ||
		snippet.thumbnails.standard?.url ||
		snippet.thumbnails.high?.url ||
		snippet.thumbnails.medium?.url ||
		null;

	const chapters = parseChaptersFromDescription(snippet.description);

	let transcriptResult = EMPTY_TRANSCRIPT;
	const durationSeconds = parseDurationSeconds(video.contentDetails.duration);
	const shouldFetchTranscript =
		!options.minDurationSecondsForTranscript || !durationSeconds || durationSeconds >= options.minDurationSecondsForTranscript;
	if (shouldFetchTranscript) {
		try {
			transcriptResult = await fetchTranscript(videoId);
		} catch (e) {
			console.warn({ tag: 'YOUTUBE', msg: 'Failed to fetch transcript', videoId, error: String(e) });
		}
	} else {
		console.info({
			tag: 'YOUTUBE',
			msg: 'Skipping transcript for short video',
			videoId,
			duration: video.contentDetails.duration,
			threshold: options.minDurationSecondsForTranscript,
		});
	}
	const { segments: transcript, language: transcriptLanguage } = transcriptResult;
	const content = buildYouTubeContent(snippet.description, transcript);

	console.info({ tag: 'YOUTUBE', msg: 'Video fetched', title: snippet.title });

	return {
		title: snippet.title,
		content,
		summary: snippet.description.substring(0, 500) || undefined,
		ogImageUrl: thumbnailUrl,
		siteName: 'YouTube',
		author: snippet.channelTitle,
		publishedDate: snippet.publishedAt,
		metadata: {
			videoId: video.id,
			channelName: snippet.channelTitle,
			channelId: snippet.channelId,
			duration: video.contentDetails.duration,
			thumbnailUrl: thumbnailUrl ?? undefined,
			viewCount: stats.viewCount ? Number.parseInt(stats.viewCount, 10) : undefined,
			likeCount: stats.likeCount ? Number.parseInt(stats.likeCount, 10) : undefined,
			commentCount: stats.commentCount ? Number.parseInt(stats.commentCount, 10) : undefined,
			tags: snippet.tags || [],
			publishedAt: snippet.publishedAt,
			description: snippet.description || '',
		},
		youtubeTranscript:
			transcript.length > 0
				? { videoId: video.id, segments: transcript, language: transcriptLanguage, chapters, chaptersFromDescription: chapters.length > 0 }
				: undefined,
	};
}
