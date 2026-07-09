import { CORE_JSON_MODEL, generateObject } from '@core-ai/embedding';
import type { Article, TranscriptSegment, YoutubeTranscript } from '@core-shared/types';
import { FEED_UA, fetchWithTimeout, normalizeUrl, readTextWithLimit } from '@core-shared/web';
import { extractFromXml, type FeedEntry } from '@extractus/feed-extractor';
import { getExistingArticlesByUrl } from '@ingest/domain/article-store';
import { enqueueProcessing } from '@ingest/workflow';
import { Client } from 'pg';
import { z } from 'zod';
import { parseDurationSeconds, scrapeYouTube } from './youtube-acquisition';

const SHORTS_MAX_SECONDS = 180;
const MAX_FEED_BYTES = 1024 * 1024;
const SOURCE_FEED_FIELDS = 'id, name, "RSSLink"';

const YouTubeHighlightSchema = z.object({
	title: z.string().min(1),
	summary: z.string().min(1),
	startTime: z.number().nonnegative(),
	endTime: z.number().nonnegative(),
});

type YouTubeHighlight = z.infer<typeof YouTubeHighlightSchema>;

interface YouTubeHighlightsUpdate {
	videoId: string;
	value: {
		version: '1.0';
		model: string;
		highlights: YouTubeHighlight[];
		generatedAt: string;
	};
}

const HIGHLIGHTS_SYSTEM_PROMPT = `你是專業的影片內容分析師。分析 YouTube 影片逐字稿，找出 5-8 個最重要的主題段落。

規則：
1. 每個段落代表一個獨立主題
2. 段落之間不重疊
3. 標題要精簡有力（30字內）
4. 時間戳記要準確對應討論內容的起止
5. 所有文字使用繁體中文

只回傳符合 schema 的資料。`;

const YouTubeHighlightsSchema = z.object({
	highlights: z.array(YouTubeHighlightSchema).min(1),
});

export async function persistYouTubeWorkflowData(
	db: Client,
	input: { transcript?: YoutubeTranscript | null; highlights?: YouTubeHighlightsUpdate | null },
): Promise<void> {
	if (input.transcript) {
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
				input.transcript.videoId,
				JSON.stringify(input.transcript.segments),
				input.transcript.language,
				input.transcript.chapters ? JSON.stringify(input.transcript.chapters) : null,
				input.transcript.chaptersFromDescription ?? null,
				new Date(),
			],
		);
	}
	if (input.highlights) {
		await db.query('UPDATE youtube_transcripts SET ai_highlights = $1, highlights_generated_at = $2 WHERE video_id = $3', [
			JSON.stringify(input.highlights.value),
			input.highlights.value.generatedAt,
			input.highlights.videoId,
		]);
	}
}

export async function prepareYouTubeHighlights(
	env: CoreEnv,
	article: Article,
	transcript?: YoutubeTranscript | null,
): Promise<YouTubeHighlightsUpdate | null> {
	if (article.platform_metadata?.type !== 'youtube') return null;

	const videoId = article.platform_metadata.data.videoId;
	if (!videoId) return null;
	if (transcript) return prepareYouTubeHighlightsFromTranscript(env, videoId, transcript.segments);

	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	const row = (
		await db.query<{ transcript: TranscriptSegment[] | null; ai_highlights: unknown }>(
			'SELECT transcript, ai_highlights FROM youtube_transcripts WHERE video_id = $1',
			[videoId],
		)
	).rows[0];
	if (!row || row.ai_highlights || !Array.isArray(row.transcript) || row.transcript.length === 0) return null;

	return prepareYouTubeHighlightsFromTranscript(env, videoId, row.transcript);
}

async function prepareYouTubeHighlightsFromTranscript(
	env: CoreEnv,
	videoId: string,
	transcript: TranscriptSegment[],
): Promise<YouTubeHighlightsUpdate | null> {
	console.info({ tag: 'AI', msg: 'Generating YouTube highlights', videoId });

	const transcriptText = transcript.map((s) => `[${Math.floor(s.startTime)}s] ${s.text}`).join('\n');
	const last = transcript[transcript.length - 1];
	const duration = Math.ceil(last.endTime);

	const highlights = await generateObject(env.AI, `影片總長度：${duration} 秒\n\n逐字稿：\n${transcriptText}`, {
		schema: YouTubeHighlightsSchema,
		task: 'youtube-highlights',
		gatewayId: env.AI_GATEWAY_NAME,
		maxTokens: 2000,
		temperature: 0.3,
		systemPrompt: HIGHLIGHTS_SYSTEM_PROMPT,
	});

	if (!highlights?.highlights.length) {
		console.error({ tag: 'AI', msg: 'YouTube highlights: invalid JSON', videoId });
		return null;
	}

	console.info({ tag: 'AI', msg: 'YouTube highlights generated', videoId, count: highlights.highlights.length });
	const generatedAt = new Date().toISOString();
	return {
		videoId,
		value: {
			version: '1.0',
			model: CORE_JSON_MODEL,
			highlights: highlights.highlights,
			generatedAt,
		},
	};
}

function parseFeedVideos(xml: string) {
	const entries = (extractFromXml(xml, {
		descriptionMaxLen: 0,
		getExtraEntryFields: (entry) => ({ videoId: entry['yt:videoId'] }),
	}).entries ?? []) as Array<FeedEntry & { videoId?: unknown }>;

	return entries.flatMap((entry) =>
		typeof entry.videoId === 'string'
			? [{ videoId: entry.videoId, url: normalizeUrl(entry.link ?? `https://youtube.com/watch?v=${entry.videoId}`) }]
			: [],
	);
}

async function queueYouTubeVideo(env: CoreEnv, channel: { name: string }, video: { videoId: string; url: string }): Promise<boolean> {
	try {
		const scraped = await scrapeYouTube(video.videoId, env.YOUTUBE_API_KEY, {
			minDurationSecondsForTranscript: SHORTS_MAX_SECONDS,
		});
		const youtubeMetadata = scraped.platformMetadata.data;
		const duration = youtubeMetadata.duration;
		const title = scraped.title || `YouTube video ${video.videoId}`;
		if (duration && parseDurationSeconds(duration) < SHORTS_MAX_SECONDS) {
			console.info({ tag: 'YOUTUBE-CRON', msg: 'Skipping short', videoId: video.videoId, duration });
			return false;
		}

		await enqueueProcessing(env, {
			kind: 'source',
			draft: {
				article: {
					url: video.url,
					title,
					source: youtubeMetadata.channelName,
					publishedDate: scraped.metadata.publishedDate ?? new Date().toISOString(),
					summary: scraped.metadata.description ?? '',
					sourceType: 'youtube',
					content: scraped.markdown,
					platformMetadata: scraped.platformMetadata,
				},
				youtubeTranscript: scraped.youtubeTranscript,
			},
		});
		console.info({ tag: 'YOUTUBE-CRON', msg: 'Started video workflow', channel: channel.name, title: title.slice(0, 60) });
		return true;
	} catch (err) {
		console.warn({ tag: 'YOUTUBE-CRON', msg: 'Video process failed', videoId: video.videoId, error: String(err) });
		return false;
	}
}

export async function handleYouTubeCron(env: CoreEnv): Promise<void> {
	if (!env.YOUTUBE_API_KEY) {
		console.info({ tag: 'YOUTUBE-CRON', msg: 'Skipped — YOUTUBE_API_KEY not configured' });
		return;
	}
	console.info({ tag: 'YOUTUBE-CRON', msg: 'start' });
	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	const channels = (
		await db.query<{ id: string; name: string; RSSLink: string | null }>(`SELECT ${SOURCE_FEED_FIELDS} FROM "RssList" WHERE type = $1`, [
			'youtube_channel',
		])
	).rows;

	let totalQueued = 0;
	for (const channel of channels) {
		try {
			if (!channel.RSSLink) continue;
			const res = await fetchWithTimeout(channel.RSSLink, { headers: { 'User-Agent': FEED_UA } });
			if (!res.ok) {
				console.warn({ tag: 'YOUTUBE-CRON', msg: 'Feed fetch failed', channel: channel.name, status: res.status });
				continue;
			}

			const videos = parseFeedVideos(await readTextWithLimit(res, MAX_FEED_BYTES));
			if (videos.length === 0) {
				console.info({ tag: 'YOUTUBE-CRON', msg: 'Feed has no videos', channel: channel.name });
				await db.query(`UPDATE "RssList" SET scraped_at = $1 WHERE id = $2`, [new Date(), channel.id]);
				continue;
			}

			const videoUrls = videos.map(({ url }) => url);
			const existingRecords = await getExistingArticlesByUrl(db, videoUrls);
			const existingSet = new Set(existingRecords.map((record) => normalizeUrl(record.url)));
			const newVideos = videos.filter(({ url }) => !existingSet.has(url));

			if (!newVideos.length) {
				console.info({ tag: 'YOUTUBE-CRON', msg: 'No new videos', channel: channel.name });
			}

			for (const video of newVideos) {
				if (await queueYouTubeVideo(env, channel, video)) totalQueued++;
			}

			await db.query(`UPDATE "RssList" SET scraped_at = $1 WHERE id = $2`, [new Date(), channel.id]);
		} catch (err) {
			console.error({ tag: 'YOUTUBE-CRON', msg: 'Channel failed', channel: channel.name, error: String(err) });
		}
	}
	console.info({ tag: 'YOUTUBE-CRON', msg: 'end', queued: totalQueued, channels: channels.length });
}
