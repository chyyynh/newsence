import { fetchWithTimeout, readTextWithLimit } from '@core-shared/http';
import type { NormalizedContent, PlatformMetadata, TranscriptSegment, YouTubeChapter } from '@core-shared/types';

const TRANSCRIPT_FETCH_TIMEOUT_MS = 8_000;
const YOUTUBE_API_TIMEOUT_MS = 15_000;
const YOUTUBE_API_MAX_BYTES = 1024 * 1024;

interface YouTubeVideoItem {
	id: string;
	snippet: {
		title: string;
		description: string;
		channelId: string;
		channelTitle: string;
		defaultAudioLanguage?: string;
		publishedAt: string;
		thumbnails: {
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
		chapters.push({ title, startTime });
	}

	for (let i = 0; i < chapters.length - 1; i++) {
		chapters[i].endTime = chapters[i + 1].startTime;
	}

	return chapters.length >= 2 ? chapters : [];
}

const transcriptFetch: typeof fetch = (input, init) => {
	const url = typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
	return fetchWithTimeout(url, init, TRANSCRIPT_FETCH_TIMEOUT_MS);
};

function toSeconds(value: string | number | undefined, field: string, videoId: string): number {
	const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number.parseFloat(value) : Number.NaN;
	if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`YouTube transcript ${videoId} has invalid ${field}`);
	return parsed;
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
		const message = String(error);
		throw new Error(
			`YouTube API request failed for ${videoId}: ${youtubeApiKey ? message.replaceAll(youtubeApiKey, '[redacted]') : message}`,
		);
	}
}

async function fetchTranscript(videoId: string): Promise<TranscriptSegment[]> {
	const { YoutubeTranscript } = await import('youtube-transcript');
	const items = await YoutubeTranscript.fetchTranscript(videoId, { fetch: transcriptFetch });

	if (!items?.length) {
		console.info({ tag: 'YOUTUBE', msg: 'Transcript unavailable; using video description', videoId });
		return [];
	}

	const segments: TranscriptSegment[] = items.map((item: { offset: number; duration: number; text: string }) => {
		const startTime = toSeconds(item.offset, 'offset', videoId) / 1000;
		return {
			startTime,
			endTime: startTime + toSeconds(item.duration, 'duration', videoId) / 1000,
			text: item.text,
		};
	});

	console.info({ tag: 'YOUTUBE', msg: 'Transcript fetched', provider: 'youtube-transcript', count: segments.length });
	return segments;
}

export async function scrapeYouTube(
	videoId: string,
	youtubeApiKey: string,
): Promise<NormalizedContent<'youtube'> & { platformMetadata: PlatformMetadata<'youtube'> }> {
	console.info({ tag: 'YOUTUBE', msg: 'Fetching video', videoId });

	const videoData = await fetchYouTubeVideoData(videoId, youtubeApiKey);

	if (videoData.error) throw new Error(`YouTube API: ${videoData.error.message}`);
	if (!videoData.items?.length) throw new Error('Video not found');

	const video = videoData.items[0];
	const snippet = video.snippet;
	const stats = video.statistics;

	const thumbnailUrl = snippet.thumbnails.maxres?.url ?? null;

	const chapters = parseChaptersFromDescription(snippet.description);

	console.info({ tag: 'YOUTUBE', msg: 'Fetching transcript', videoId });
	const transcript = await fetchTranscript(videoId);
	const transcriptMarkdown = transcript
		.map((segment) => segment.text.trim())
		.filter(Boolean)
		.join('\n');
	const content = transcriptMarkdown || snippet.description.trim();

	console.info({ tag: 'YOUTUBE', msg: 'Video fetched', title: snippet.title });

	return {
		type: 'youtube',
		title: snippet.title,
		markdown: content,
		metadata: {
			author: snippet.channelTitle,
			language: snippet.defaultAudioLanguage ?? null,
			publishedDate: snippet.publishedAt,
			siteName: 'YouTube',
			description: snippet.description.substring(0, 500) || null,
		},
		previewImageUrl: thumbnailUrl,
		platformMetadata: {
			fetchedAt: new Date().toISOString(),
			data: {
				videoId: video.id,
				channelName: snippet.channelTitle,
				channelId: snippet.channelId,
				duration: video.contentDetails.duration,
				...(thumbnailUrl ? { thumbnailUrl } : {}),
				viewCount: stats.viewCount ? Number.parseInt(stats.viewCount, 10) : undefined,
				likeCount: stats.likeCount ? Number.parseInt(stats.likeCount, 10) : undefined,
				commentCount: stats.commentCount ? Number.parseInt(stats.commentCount, 10) : undefined,
				tags: snippet.tags,
				publishedAt: snippet.publishedAt,
				description: snippet.description,
			},
		},
		youtubeTranscript: {
			videoId: video.id,
			segments: transcript,
			language: snippet.defaultAudioLanguage ?? null,
			chapters,
			chaptersFromDescription: chapters.length > 0,
		},
	};
}
