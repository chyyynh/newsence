import { CORE_JSON_MODEL, generateObject } from '@core-ai/generation';
import { fetchWithTimeout, readTextWithLimit, WEB_FETCH_USER_AGENT } from '@core-shared/http';
import { platformMetadataFor, type ResourceForProcessing, type TranscriptSegment, type YoutubeTranscript } from '@core-shared/types';
import { normalizeUrl } from '@core-shared/url';
import { type CoreDb, withCoreDb } from '@db/client';
import { youtubeTranscripts } from '@db/schema';
import { extractFromXml, type FeedEntry } from '@extractus/feed-extractor';
import { attachSourceToResources, getExistingResourcesByUrl, upsertPendingSourceResource } from '@ingest/domain/resource-store';
import { loadMonitoredSources, type MonitoredSource, markSourceScraped } from '@ingest/domain/source-store';
import { enqueueProcessing } from '@ingest/workflow';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { scrapeYouTube } from './youtube-acquisition';

const MAX_FEED_BYTES = 1024 * 1024;

const YouTubeHighlightSchema = z.object({
	title: z.string().min(1),
	summary: z.string().min(1),
	startTime: z.number().nonnegative(),
	endTime: z.number().nonnegative(),
});

type YouTubeHighlight = z.infer<typeof YouTubeHighlightSchema>;

export interface YouTubeHighlightsUpdate {
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
				chapters: input.transcript.chapters,
				chaptersFromDescription: input.transcript.chaptersFromDescription,
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
	resource: ResourceForProcessing,
	transcript?: YoutubeTranscript | null,
): Promise<YouTubeHighlightsUpdate | null> {
	if (resource.type !== 'youtube') return null;
	const metadata = platformMetadataFor(resource, 'youtube');
	if (!metadata) return null;

	const videoId = metadata.data.videoId;
	if (!videoId) return null;
	if (transcript) {
		return transcript.segments.length ? prepareYouTubeHighlightsFromTranscript(env, videoId, transcript.segments) : null;
	}

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
		throw new Error(`YouTube highlights did not return valid output for ${videoId}`);
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
	const feed = extractFromXml(xml, {
		descriptionMaxLen: 0,
		getExtraEntryFields: (entry) => ({ videoId: entry['yt:videoId'] }),
	});
	if (!Array.isArray(feed.entries)) throw new Error('YouTube feed parser returned no entries');
	const entries = feed.entries as Array<FeedEntry & { videoId?: unknown }>;
	const videos: Array<{ videoId: string; url: string }> = [];
	for (const entry of entries) {
		try {
			if (typeof entry.videoId !== 'string' || !entry.videoId.trim()) throw new Error('Feed entry is missing videoId');
			if (!entry.link?.trim()) throw new Error(`Feed entry ${entry.videoId} is missing link`);
			const url = normalizeUrl(entry.link);
			if (!new URL(url).pathname.startsWith('/shorts/')) videos.push({ videoId: entry.videoId, url });
		} catch (error) {
			console.error({
				tag: 'YOUTUBE-CRON',
				msg: 'Skipped invalid feed entry',
				videoId: typeof entry.videoId === 'string' ? entry.videoId : undefined,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return videos;
}

async function queueYouTubeVideo(
	env: CoreEnv,
	channel: { id: string; name: string },
	video: { videoId: string; url: string },
): Promise<void> {
	const scraped = await scrapeYouTube(video.videoId, env.YOUTUBE_API_KEY);
	const youtubeMetadata = scraped.platformMetadata.data;
	const title = scraped.title?.trim();
	if (!title) throw new Error(`YouTube video ${video.videoId} has no title`);
	const publishedDate = scraped.metadata.publishedDate;
	if (!publishedDate) throw new Error(`YouTube video ${video.videoId} has no published date`);

	const resourceId = await withCoreDb(env, async (db) => {
		const resourceId = await upsertPendingSourceResource(db, {
			sourceId: channel.id,
			url: video.url,
			title,
			source: youtubeMetadata.channelName,
			publishedDate,
			summary: scraped.metadata.description,
			type: 'youtube',
			originalLang: scraped.metadata.language ?? undefined,
			content: scraped.markdown,
			platformMetadata: scraped.platformMetadata,
			previewImageUrl: scraped.previewImageUrl,
		});
		await persistYouTubeWorkflowData(db, { transcript: scraped.youtubeTranscript });
		return resourceId;
	});
	await enqueueProcessing(env, resourceId);
	console.info({ tag: 'YOUTUBE-CRON', msg: 'Started video workflow', channel: channel.name, title: title.slice(0, 60) });
}

async function retryExistingYouTubeVideos(
	env: CoreEnv,
	channelName: string,
	records: Array<{ id: string; shouldRetryEnrichment: boolean }>,
): Promise<number> {
	let queued = 0;
	for (const record of records) {
		if (!record.shouldRetryEnrichment) continue;
		try {
			await enqueueProcessing(env, record.id);
			queued++;
		} catch (error) {
			console.error({
				tag: 'YOUTUBE-CRON',
				msg: 'Failed to retry video workflow',
				channel: channelName,
				resourceId: record.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return queued;
}

async function queueNewYouTubeVideos(
	env: CoreEnv,
	channel: { id: string; name: string },
	videos: Array<{ videoId: string; url: string }>,
): Promise<number> {
	let queued = 0;
	for (const video of videos) {
		try {
			await queueYouTubeVideo(env, channel, video);
			queued++;
		} catch (error) {
			console.error({
				tag: 'YOUTUBE-CRON',
				msg: 'Failed to queue video',
				channel: channel.name,
				videoId: video.videoId,
				url: video.url,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return queued;
}

async function processYouTubeChannel(env: CoreEnv, channel: MonitoredSource): Promise<number> {
	const res = await fetchWithTimeout(channel.handle, { headers: { 'User-Agent': WEB_FETCH_USER_AGENT } });
	if (!res.ok) {
		await res.body?.cancel();
		throw new Error(`YouTube feed ${channel.name} failed with HTTP ${res.status}`);
	}

	const videos = parseFeedVideos(await readTextWithLimit(res, MAX_FEED_BYTES));
	if (videos.length === 0) {
		console.info({ tag: 'YOUTUBE-CRON', msg: 'Feed has no videos', channel: channel.name });
		await markSourceScraped(env, channel.id);
		return 0;
	}

	const videoUrls = videos.map(({ url }) => url);
	const existingRecords = await withCoreDb(env, (db) => getExistingResourcesByUrl(db, videoUrls));
	await withCoreDb(env, (db) =>
		attachSourceToResources(
			db,
			existingRecords.map((record) => record.id),
			channel.id,
			'youtube',
		),
	);
	const existingSet = new Set(existingRecords.map((record) => normalizeUrl(record.url)));
	const newVideos = videos.filter(({ url }) => !existingSet.has(url));
	let queued = await retryExistingYouTubeVideos(env, channel.name, existingRecords);

	if (!newVideos.length) console.info({ tag: 'YOUTUBE-CRON', msg: 'No new videos', channel: channel.name });
	queued += await queueNewYouTubeVideos(env, channel, newVideos);

	await markSourceScraped(env, channel.id);
	return queued;
}

export async function handleYouTubeCron(env: CoreEnv): Promise<void> {
	if (!env.YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY is not configured');
	console.info({ tag: 'YOUTUBE-CRON', msg: 'start' });
	const channels = await loadMonitoredSources(env, 'youtube');

	let totalQueued = 0;
	const failures: unknown[] = [];
	for (const channel of channels) {
		try {
			totalQueued += await processYouTubeChannel(env, channel);
		} catch (error) {
			failures.push(error);
			console.error({
				tag: 'YOUTUBE-CRON',
				msg: 'Channel processing failed',
				channel: channel.name,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	console.info({ tag: 'YOUTUBE-CRON', msg: 'end', queued: totalQueued, channels: channels.length });
	if (failures.length) throw new AggregateError(failures, `${failures.length} YouTube channels failed`);
}
