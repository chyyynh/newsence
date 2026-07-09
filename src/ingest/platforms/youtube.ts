import { CORE_JSON_MODEL, generateObject } from '@core-ai/embedding';
import type { Article, TranscriptSegment, YoutubeTranscript } from '@core-shared/types';
import { FEED_UA, fetchWithTimeout, normalizeUrl, readTextWithLimit } from '@core-shared/web';
import { type CoreDb, withCoreDb } from '@db/client';
import { rssList, youtubeTranscripts } from '@db/schema';
import { extractFromXml, type FeedEntry } from '@extractus/feed-extractor';
import { getExistingResourcesByUrl, upsertPendingSourceResource } from '@ingest/domain/article-store';
import { enqueueProcessing } from '@ingest/workflow';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { parseDurationSeconds, scrapeYouTube } from './youtube-acquisition';

const SHORTS_MAX_SECONDS = 180;
const MAX_FEED_BYTES = 1024 * 1024;

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
	db: CoreDb,
	input: { transcript?: YoutubeTranscript | null; highlights?: YouTubeHighlightsUpdate | null },
): Promise<void> {
	if (input.transcript) {
		await db
			.insert(youtubeTranscripts)
			.values({
				videoId: input.transcript.videoId,
				transcript: input.transcript.segments,
				language: input.transcript.language,
				chapters: input.transcript.chapters ?? [],
				chaptersFromDescription: input.transcript.chaptersFromDescription ?? false,
				fetchedAt: new Date(),
			})
			.onConflictDoUpdate({
				target: youtubeTranscripts.videoId,
				set: {
					transcript: sql`excluded.transcript`,
					language: sql`excluded.language`,
					chapters: sql`excluded.chapters`,
					chaptersFromDescription: sql`excluded.chapters_from_description`,
					fetchedAt: sql`excluded.fetched_at`,
				},
			});
	}
	if (input.highlights) {
		await db
			.update(youtubeTranscripts)
			.set({ aiHighlights: input.highlights.value, highlightsGeneratedAt: new Date(input.highlights.value.generatedAt) })
			.where(eq(youtubeTranscripts.videoId, input.highlights.videoId));
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

	const row = await withCoreDb(
		env,
		async (db) =>
			(
				await db
					.select({ transcript: youtubeTranscripts.transcript, aiHighlights: youtubeTranscripts.aiHighlights })
					.from(youtubeTranscripts)
					.where(eq(youtubeTranscripts.videoId, videoId))
					.limit(1)
			)[0],
	);
	if (!row || row.aiHighlights || !Array.isArray(row.transcript) || row.transcript.length === 0) return null;

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

		const resourceId = await withCoreDb(env, async (db) => {
			const resourceId = await upsertPendingSourceResource(db, {
				url: video.url,
				title,
				source: youtubeMetadata.channelName,
				publishedDate: scraped.metadata.publishedDate ?? new Date().toISOString(),
				summary: scraped.metadata.description ?? '',
				sourceType: 'youtube',
				content: scraped.markdown,
				platformMetadata: scraped.platformMetadata,
			});
			await persistYouTubeWorkflowData(db, { transcript: scraped.youtubeTranscript });
			return resourceId;
		});
		await enqueueProcessing(env, {
			kind: 'resource',
			rowId: resourceId,
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
	const channels = await withCoreDb(env, async (db) =>
		db.select({ id: rssList.id, name: rssList.name, RSSLink: rssList.rssLink }).from(rssList).where(eq(rssList.type, 'youtube_channel')),
	);

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
				await markChannelScraped(env, channel.id);
				continue;
			}

			const videoUrls = videos.map(({ url }) => url);
			const existingRecords = await withCoreDb(env, (db) => getExistingResourcesByUrl(db, videoUrls));
			const existingSet = new Set(existingRecords.map((record) => normalizeUrl(record.url)));
			const newVideos = videos.filter(({ url }) => !existingSet.has(url));

			if (!newVideos.length) {
				console.info({ tag: 'YOUTUBE-CRON', msg: 'No new videos', channel: channel.name });
			}

			for (const video of newVideos) {
				if (await queueYouTubeVideo(env, channel, video)) totalQueued++;
			}

			await markChannelScraped(env, channel.id);
		} catch (err) {
			console.error({ tag: 'YOUTUBE-CRON', msg: 'Channel failed', channel: channel.name, error: String(err) });
		}
	}
	console.info({ tag: 'YOUTUBE-CRON', msg: 'end', queued: totalQueued, channels: channels.length });
}

async function markChannelScraped(env: CoreEnv, channelId: number): Promise<void> {
	await withCoreDb(env, async (db) => {
		await db.update(rssList).set({ scrapedAt: new Date() }).where(eq(rssList.id, channelId));
	});
}
