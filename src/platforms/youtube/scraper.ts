// ─────────────────────────────────────────────────────────────
// YouTube Scraper
// ─────────────────────────────────────────────────────────────

import { logInfo, logWarn } from '../../infra/log';
import type { ScrapedContent, TranscriptSegment, YouTubeChapter } from '../../models/scraped-content';

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

function parseChaptersFromDescription(description: string): YouTubeChapter[] {
	const chapterRegex = /(?:^|\n)(\d{1,2}:)?(\d{1,2}):(\d{2})\s+(.+?)(?=\n|$)/g;
	const chapters: YouTubeChapter[] = [];

	let match;
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

async function fetchTranscript(videoId: string): Promise<{ segments: TranscriptSegment[]; language: string | null }> {
	logInfo('YOUTUBE', 'Fetching transcript', { videoId });

	const { YoutubeTranscript } = await import('youtube-transcript');
	const items = await YoutubeTranscript.fetchTranscript(videoId);

	if (!items?.length) return EMPTY_TRANSCRIPT;

	// In Worker environment, only the ANDROID InnerTube path succeeds (video page
	// scrape is blocked by YouTube from datacenter IPs). The ANDROID path always
	// returns srv3 format where offset/duration are in milliseconds.
	const segments: TranscriptSegment[] = items.map((item: { offset: number; duration: number; text: string }) => ({
		startTime: item.offset / 1000,
		endTime: (item.offset + item.duration) / 1000,
		text: item.text,
	}));

	const language = items[0].lang ?? null;
	logInfo('YOUTUBE', 'Transcript fetched', { count: segments.length, language });
	return { segments, language };
}

export async function scrapeYouTube(videoId: string, youtubeApiKey: string): Promise<ScrapedContent> {
	logInfo('YOUTUBE', 'Fetching video', { videoId });

	const videoResponse = await fetch(
		`https://www.googleapis.com/youtube/v3/videos?id=${videoId}&part=snippet,contentDetails,statistics&key=${youtubeApiKey}`,
	);

	if (!videoResponse.ok) {
		throw new Error(`YouTube API error: HTTP ${videoResponse.status}`);
	}

	const videoData = (await videoResponse.json()) as { items?: YouTubeVideoItem[]; error?: { message: string } };

	if (videoData.error) throw new Error(`YouTube API: ${videoData.error.message}`);
	if (!videoData.items?.length) throw new Error('Video not found');

	const video = videoData.items[0];
	const snippet = video.snippet;
	const stats = video.statistics;

	// Fetch channel avatar
	let channelAvatar: string | null = null;
	try {
		const channelResponse = await fetch(
			`https://www.googleapis.com/youtube/v3/channels?id=${snippet.channelId}&part=snippet&key=${youtubeApiKey}`,
		);
		if (channelResponse.ok) {
			const channelData = (await channelResponse.json()) as {
				items?: Array<{ snippet: { thumbnails: { medium?: { url: string }; default?: { url: string } } } }>;
			};
			channelAvatar = channelData.items?.[0]?.snippet?.thumbnails?.medium?.url ?? null;
		}
	} catch (e) {
		logWarn('YOUTUBE', 'Failed to fetch channel avatar', { error: String(e) });
	}

	const thumbnailUrl =
		snippet.thumbnails.maxres?.url ||
		snippet.thumbnails.standard?.url ||
		snippet.thumbnails.high?.url ||
		snippet.thumbnails.medium?.url ||
		null;

	const chapters = parseChaptersFromDescription(snippet.description);

	// Fetch transcript via InnerTube API (youtube-transcript package)
	let transcriptResult = EMPTY_TRANSCRIPT;
	try {
		transcriptResult = await fetchTranscript(videoId);
	} catch (e) {
		logWarn('YOUTUBE', 'Failed to fetch transcript', { error: String(e) });
	}
	const { segments: transcript, language: transcriptLanguage } = transcriptResult;

	logInfo('YOUTUBE', 'Video fetched', { title: snippet.title });

	return {
		title: snippet.title,
		content: '',
		summary: snippet.description.substring(0, 500) || undefined,
		ogImageUrl: thumbnailUrl,
		siteName: 'YouTube',
		author: snippet.channelTitle,
		publishedDate: snippet.publishedAt,
		metadata: {
			videoId: video.id,
			channelName: snippet.channelTitle,
			channelId: snippet.channelId,
			channelAvatar,
			duration: video.contentDetails.duration,
			thumbnailUrl,
			viewCount: stats.viewCount ? parseInt(stats.viewCount) : undefined,
			likeCount: stats.likeCount ? parseInt(stats.likeCount) : undefined,
			commentCount: stats.commentCount ? parseInt(stats.commentCount) : undefined,
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
