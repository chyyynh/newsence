import { fetchWithTimeout, readTextWithLimit } from '@core-shared/http';
import type { NormalizedContent, PlatformMetadata, TranscriptSegment, YouTubeChapter } from '@core-shared/types';
import { z } from 'zod';
import type { AcquisitionOrigin } from '../acquisition';

const TRANSCRIPT_FETCH_TIMEOUT_MS = 8_000;
const YOUTUBE_API_TIMEOUT_MS = 15_000;
const YOUTUBE_API_MAX_BYTES = 1024 * 1024;
// Shorts and clips this brief carry no transcript worth reading, so a monitored
// channel does not contribute them. The channel Atom feed exposes no duration and
// links Shorts as /watch?v= like everything else, so this is the first point in
// the pipeline that can tell them apart at all — hence a policy check this deep,
// gated on whether the URL came from a feed or from a person.
const MIN_VIDEO_DURATION_SECONDS = 180;

const YouTubeThumbnailSchema = z.object({ url: z.string().min(1) });
const YouTubeThumbnailsSchema = z.object({
	default: YouTubeThumbnailSchema.optional(),
	medium: YouTubeThumbnailSchema.optional(),
	high: YouTubeThumbnailSchema.optional(),
	standard: YouTubeThumbnailSchema.optional(),
	maxres: YouTubeThumbnailSchema.optional(),
});
const YouTubeCountSchema = z.string().regex(/^\d+$/);
const YouTubeApiErrorSchema = z.object({ message: z.string() });
const YouTubeVideoItemSchema = z.object({
	id: z.string().min(1),
	snippet: z.object({
		title: z.string(),
		description: z.string(),
		channelId: z.string().min(1),
		channelTitle: z.string(),
		defaultAudioLanguage: z.string().optional(),
		publishedAt: z.string().min(1),
		thumbnails: YouTubeThumbnailsSchema,
		tags: z.array(z.string()).optional(),
	}),
	contentDetails: z.object({ duration: z.string().min(1) }),
	statistics: z.object({
		viewCount: YouTubeCountSchema.optional(),
		likeCount: YouTubeCountSchema.optional(),
		commentCount: YouTubeCountSchema.optional(),
	}),
});
const YouTubeVideosResponseSchema = z.object({
	items: z.array(YouTubeVideoItemSchema).optional(),
	error: YouTubeApiErrorSchema.optional(),
});
const YouTubeChannelsResponseSchema = z.object({
	items: z
		.array(
			z.object({
				snippet: z.object({ thumbnails: YouTubeThumbnailsSchema }),
			}),
		)
		.optional(),
	error: YouTubeApiErrorSchema.optional(),
});

type YouTubeThumbnails = z.infer<typeof YouTubeThumbnailsSchema>;
type YouTubeVideosResponse = z.infer<typeof YouTubeVideosResponseSchema>;

function bestThumbnailUrl(thumbnails: YouTubeThumbnails): string | null {
	return (
		thumbnails.maxres?.url ?? thumbnails.standard?.url ?? thumbnails.high?.url ?? thumbnails.medium?.url ?? thumbnails.default?.url ?? null
	);
}

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

/**
 * ISO-8601 duration as the videos endpoint returns it: PT1H2M3S, PT58S, PT3M.
 * Null when there is no real length yet — a live stream or an unstarted premiere
 * reports `P0D`.
 */
function isoDurationSeconds(duration: string): number | null {
	const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(duration.trim());
	if (!match) throw new Error(`Unparseable YouTube duration: ${duration}`);
	const [, days, hours, minutes, seconds] = match;
	const total = Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0);
	return total > 0 ? total : null;
}

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

		return YouTubeVideosResponseSchema.parse(JSON.parse(await readTextWithLimit(response, YOUTUBE_API_MAX_BYTES)));
	} catch (error) {
		const message = String(error);
		throw new Error(
			`YouTube API request failed for ${videoId}: ${youtubeApiKey ? message.replaceAll(youtubeApiKey, '[redacted]') : message}`,
		);
	}
}

async function fetchYouTubeChannelAvatar(channelId: string, youtubeApiKey: string): Promise<string | null> {
	const url = new URL('https://www.googleapis.com/youtube/v3/channels');
	url.searchParams.set('id', channelId);
	url.searchParams.set('part', 'snippet');
	url.searchParams.set('key', youtubeApiKey);

	try {
		const response = await fetchWithTimeout(url.toString(), undefined, YOUTUBE_API_TIMEOUT_MS);
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const channelData = YouTubeChannelsResponseSchema.parse(JSON.parse(await readTextWithLimit(response, YOUTUBE_API_MAX_BYTES)));
		if (channelData.error) throw new Error(channelData.error.message);
		if (!channelData.items?.length) throw new Error('Channel not found');
		return bestThumbnailUrl(channelData.items[0].snippet.thumbnails);
	} catch (error) {
		const message = String(error);
		console.warn({
			tag: 'YOUTUBE',
			msg: 'Channel avatar unavailable',
			channelId,
			error: youtubeApiKey ? message.replaceAll(youtubeApiKey, '[redacted]') : message,
		});
		return null;
	}
}

async function fetchTranscript(videoId: string): Promise<TranscriptSegment[]> {
	const { YoutubeTranscript } = await import('youtube-transcript');
	let items: Array<{ offset: number; duration: number; text: string }>;
	try {
		items = await YoutubeTranscript.fetchTranscript(videoId, { fetch: transcriptFetch });
	} catch (error) {
		console.warn({
			tag: 'YOUTUBE',
			msg: 'Transcript unavailable; using video description',
			videoId,
			error: error instanceof Error ? error.message : String(error),
		});
		return [];
	}

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
	origin: AcquisitionOrigin,
): Promise<NormalizedContent<'youtube'> & { platformMetadata: PlatformMetadata<'youtube'> }> {
	console.info({ tag: 'YOUTUBE', msg: 'Fetching video', videoId });

	const videoData = await fetchYouTubeVideoData(videoId, youtubeApiKey);

	if (videoData.error) throw new Error(`YouTube API: ${videoData.error.message}`);
	if (!videoData.items?.length) throw new Error(`YouTube video ${videoId} was not found`);

	const video = videoData.items[0];
	const snippet = video.snippet;
	const stats = video.statistics;

	// Checked before the transcript and avatar calls, so a video we do not want
	// costs one request instead of three.
	const durationSeconds = isoDurationSeconds(video.contentDetails.duration);
	if (origin.monitored && (durationSeconds === null || durationSeconds <= MIN_VIDEO_DURATION_SECONDS)) {
		const reason = durationSeconds === null ? 'is a live stream or unstarted premiere' : `runs ${durationSeconds}s`;
		throw new Error(`YouTube video ${videoId} ${reason}; wanted over ${MIN_VIDEO_DURATION_SECONDS}s`);
	}

	const thumbnailUrl = bestThumbnailUrl(snippet.thumbnails);
	const chapters = parseChaptersFromDescription(snippet.description);

	console.info({ tag: 'YOUTUBE', msg: 'Fetching transcript', videoId });
	const [channelAvatar, transcript] = await Promise.all([
		fetchYouTubeChannelAvatar(snippet.channelId, youtubeApiKey),
		fetchTranscript(videoId),
	]);
	const transcriptMarkdown = transcript
		.map((segment) => segment.text.trim())
		.filter(Boolean)
		.join('\n');
	const content = transcriptMarkdown || snippet.description.trim();

	console.info({ tag: 'YOUTUBE', msg: 'Video fetched', title: snippet.title });

	return {
		kind: 'video',
		resourcePlatform: 'youtube',
		fileType: null,
		title: snippet.title,
		markdown: content,
		metadata: {
			author: snippet.channelTitle,
			language: snippet.defaultAudioLanguage ?? null,
			publishedDate: snippet.publishedAt,
			// The channel, not the platform. This becomes platform_metadata.sourceName,
			// the display fallback when a row has no source relation — a literal
			// 'YouTube' collapses every channel into one byline. Saved YouTube URLs
			// have always landed that way; the cron only avoided it by pre-filling the
			// row so acquisition never ran.
			siteName: snippet.channelTitle.trim() || 'YouTube',
			description: snippet.description.substring(0, 500) || null,
		},
		previewImageUrl: thumbnailUrl,
		platformMetadata: {
			fetchedAt: new Date().toISOString(),
			data: {
				videoId: video.id,
				channelName: snippet.channelTitle,
				channelId: snippet.channelId,
				...(channelAvatar ? { channelAvatar } : {}),
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
