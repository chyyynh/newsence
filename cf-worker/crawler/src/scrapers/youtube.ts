import type { ScrapedContent } from '../types';

interface YouTubeVideoItem {
	id: string;
	snippet: {
		title: string;
		description: string;
		channelId: string;
		channelTitle: string;
		publishedAt: string;
		thumbnails: {
			default?: { url: string; width: number; height: number };
			medium?: { url: string; width: number; height: number };
			high?: { url: string; width: number; height: number };
			standard?: { url: string; width: number; height: number };
			maxres?: { url: string; width: number; height: number };
		};
		tags?: string[];
	};
	contentDetails: {
		duration: string; // ISO 8601 format: PT1H2M3S
	};
	statistics: {
		viewCount?: string;
		likeCount?: string;
		commentCount?: string;
	};
}

interface YouTubeVideoResponse {
	items?: YouTubeVideoItem[];
	error?: {
		code: number;
		message: string;
	};
}

interface YouTubeChannelResponse {
	items?: Array<{
		id: string;
		snippet: {
			title: string;
			thumbnails: {
				default?: { url: string };
				medium?: { url: string };
				high?: { url: string };
			};
		};
	}>;
}

interface TranscriptSegment {
	startTime: number;
	duration: number;
	text: string;
}

interface TranscriptApiResponse {
	transcript?: Array<{
		start: number;
		duration: number;
		text: string;
	}>;
	language?: string;
	error?: string;
}

interface YouTubeChapter {
	title: string;
	startTime: number;
	endTime: number;
}

/**
 * Parse chapters from YouTube video description
 */
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

/**
 * Fetch transcript from transcriptapi.com
 */
async function fetchTranscript(
	videoId: string,
	transcriptApiKey: string
): Promise<{ segments: TranscriptSegment[]; language: string | null }> {
	console.log(`[YOUTUBE-SCRAPER] Fetching transcript for ${videoId}...`);

	const url = `https://transcriptapi.com/api/v2/youtube/transcript?video_url=${videoId}&format=json`;

	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${transcriptApiKey}`,
		},
	});

	if (!response.ok) {
		console.warn(`[YOUTUBE-SCRAPER] Transcript API returned HTTP ${response.status}`);
		return { segments: [], language: null };
	}

	const data: TranscriptApiResponse = await response.json();

	if (data.error) {
		console.warn(`[YOUTUBE-SCRAPER] Transcript API error: ${data.error}`);
		return { segments: [], language: null };
	}

	if (!data.transcript || data.transcript.length === 0) {
		return { segments: [], language: data.language || null };
	}

	const segments: TranscriptSegment[] = data.transcript.map((item) => ({
		startTime: item.start,
		duration: item.duration,
		text: item.text,
	}));

	console.log(`[YOUTUBE-SCRAPER] Got ${segments.length} transcript segments`);
	return { segments, language: data.language || null };
}

/**
 * Scrapes a YouTube video using YouTube Data API v3 + transcript
 */
export async function scrapeYouTube(
	videoId: string,
	youtubeApiKey: string,
	transcriptApiKey?: string
): Promise<ScrapedContent> {
	console.log(`[YOUTUBE-SCRAPER] Fetching video ${videoId}...`);

	// Fetch video details
	const videoResponse = await fetch(
		`https://www.googleapis.com/youtube/v3/videos?` +
			`id=${videoId}&` +
			`part=snippet,contentDetails,statistics&` +
			`key=${youtubeApiKey}`
	);

	if (!videoResponse.ok) {
		throw new Error(`YouTube API error: HTTP ${videoResponse.status}`);
	}

	const videoData = (await videoResponse.json()) as YouTubeVideoResponse;

	if (videoData.error) {
		throw new Error(`YouTube API error: ${videoData.error.message}`);
	}

	if (!videoData.items || videoData.items.length === 0) {
		throw new Error('Video not found');
	}

	const video = videoData.items[0];
	const snippet = video.snippet;
	const stats = video.statistics;

	// Fetch channel avatar
	let channelAvatar: string | null = null;
	try {
		const channelResponse = await fetch(
			`https://www.googleapis.com/youtube/v3/channels?` +
				`id=${snippet.channelId}&` +
				`part=snippet&` +
				`key=${youtubeApiKey}`
		);

		if (channelResponse.ok) {
			const channelData = (await channelResponse.json()) as YouTubeChannelResponse;
			if (channelData.items && channelData.items.length > 0) {
				channelAvatar =
					channelData.items[0].snippet.thumbnails.medium?.url ||
					channelData.items[0].snippet.thumbnails.default?.url ||
					null;
			}
		}
	} catch (e) {
		console.warn('[YOUTUBE-SCRAPER] Failed to fetch channel avatar:', e);
	}

	// Get best thumbnail
	const thumbnailUrl =
		snippet.thumbnails.maxres?.url ||
		snippet.thumbnails.standard?.url ||
		snippet.thumbnails.high?.url ||
		snippet.thumbnails.medium?.url ||
		snippet.thumbnails.default?.url ||
		null;

	// Parse chapters from description
	const chapters = parseChaptersFromDescription(snippet.description);

	// Fetch transcript if API key is provided
	let transcript: TranscriptSegment[] = [];
	let transcriptLanguage: string | null = null;

	if (transcriptApiKey) {
		try {
			const transcriptResult = await fetchTranscript(videoId, transcriptApiKey);
			transcript = transcriptResult.segments;
			transcriptLanguage = transcriptResult.language;
		} catch (e) {
			console.warn('[YOUTUBE-SCRAPER] Failed to fetch transcript:', e);
		}
	}

	// Format content as markdown
	const content = formatVideoAsMarkdown(video, channelAvatar);

	console.log(`[YOUTUBE-SCRAPER] Fetched video: ${snippet.title}`);

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
			channelAvatar,
			duration: video.contentDetails.duration,
			thumbnailUrl,
			viewCount: stats.viewCount ? parseInt(stats.viewCount) : undefined,
			likeCount: stats.likeCount ? parseInt(stats.likeCount) : undefined,
			commentCount: stats.commentCount ? parseInt(stats.commentCount) : undefined,
			tags: snippet.tags || [],
			publishedAt: snippet.publishedAt,
			description: snippet.description || '',
			// Transcript data
			transcript,
			transcriptLanguage,
			chapters,
			chaptersFromDescription: chapters.length > 0,
		},
	};
}

/**
 * Formats YouTube video as Markdown content
 */
function formatVideoAsMarkdown(video: YouTubeVideoItem, channelAvatar: string | null): string {
	const snippet = video.snippet;
	const stats = video.statistics;
	const duration = formatDuration(video.contentDetails.duration);

	let md = `# ${snippet.title}\n\n`;

	// Thumbnail
	const thumbnail = snippet.thumbnails.high?.url || snippet.thumbnails.medium?.url;
	if (thumbnail) {
		md += `![Thumbnail](${thumbnail})\n\n`;
	}

	// Channel info
	md += `**Channel:** ${snippet.channelTitle}\n`;
	md += `**Published:** ${new Date(snippet.publishedAt).toLocaleDateString()}\n`;
	md += `**Duration:** ${duration}\n`;

	md += '\n---\n\n';

	// Description (truncated)
	if (snippet.description) {
		const desc = snippet.description.substring(0, 1000);
		md += `## Description\n\n${desc}${snippet.description.length > 1000 ? '...' : ''}\n\n`;
	}

	// Stats
	md += '## Statistics\n\n';
	if (stats.viewCount) {
		md += `- **Views:** ${parseInt(stats.viewCount).toLocaleString()}\n`;
	}
	if (stats.likeCount) {
		md += `- **Likes:** ${parseInt(stats.likeCount).toLocaleString()}\n`;
	}
	if (stats.commentCount) {
		md += `- **Comments:** ${parseInt(stats.commentCount).toLocaleString()}\n`;
	}

	// Tags
	if (snippet.tags && snippet.tags.length > 0) {
		md += `\n**Tags:** ${snippet.tags.slice(0, 10).join(', ')}\n`;
	}

	return md;
}

/**
 * Converts ISO 8601 duration to human readable format
 * PT1H2M3S -> 1:02:03
 */
function formatDuration(isoDuration: string): string {
	const match = isoDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
	if (!match) return isoDuration;

	const hours = match[1] ? parseInt(match[1]) : 0;
	const minutes = match[2] ? parseInt(match[2]) : 0;
	const seconds = match[3] ? parseInt(match[3]) : 0;

	if (hours > 0) {
		return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
	}
	return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
