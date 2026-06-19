import { createDbClient, enqueueArticleProcess, getExistingUrls, insertArticle, upsertYoutubeTranscript } from '@shared/db';
import { buildMetadata, type YouTubeMetadata } from '@shared/platform-metadata';
import type { Env, ExecutionContext, RSSFeed } from '@shared/types';
import { buildYouTubeWatchUrl, FEED_UA, fetchWithTimeout, readTextWithLimit } from '@shared/web';
import { XMLParser } from 'fast-xml-parser';
import { scrapeYouTube } from './scraper';

// ─────────────────────────────────────────────────────────────
// YouTube Channel Monitor
// ─────────────────────────────────────────────────────────────

/** Parse ISO 8601 duration (e.g. PT1H2M3S) to seconds */
function parseDurationSeconds(iso: string): number {
	const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
	if (!m) return 0;
	return parseInt(m[1] || '0', 10) * 3600 + parseInt(m[2] || '0', 10) * 60 + parseInt(m[3] || '0', 10);
}

interface YouTubeAtomEntry {
	'yt:videoId'?: string;
}

type FeedVideo = { videoId: string; url: string };

const SHORTS_MAX_SECONDS = 180;
const MAX_FEED_BYTES = 1024 * 1024;

async function fetchChannelVideos(channel: RSSFeed, parser: XMLParser): Promise<FeedVideo[] | null> {
	const res = await fetchWithTimeout(channel.RSSLink, { headers: { 'User-Agent': FEED_UA } });
	if (!res.ok) {
		console.warn({ tag: 'YOUTUBE-CRON', msg: 'Feed fetch failed', channel: channel.name, status: res.status });
		return null;
	}
	const feed = parser.parse(await readTextWithLimit(res, MAX_FEED_BYTES));
	const rawEntries = feed?.feed?.entry;
	if (!rawEntries) return [];
	const entries = (Array.isArray(rawEntries) ? rawEntries : [rawEntries]) as YouTubeAtomEntry[];
	return entries
		.map((entry) => entry['yt:videoId'])
		.filter((videoId): videoId is string => !!videoId)
		.map((videoId) => ({ videoId, url: buildYouTubeWatchUrl(videoId) }));
}

/** Returns true on insert, false on skip/failure. */
async function processYouTubeVideo(
	db: Awaited<ReturnType<typeof createDbClient>>,
	env: Env,
	channel: RSSFeed,
	video: FeedVideo,
): Promise<boolean> {
	const { videoId, url } = video;
	const scraped = await scrapeYouTube(videoId, env.YOUTUBE_API_KEY || '');
	const youtubeMetadata: YouTubeMetadata = {
		...scraped.metadata,
		videoId,
		channelName: scraped.author || channel.name,
		channelAvatar: scraped.metadata.channelAvatar ?? channel.avatar_url,
		thumbnailUrl: scraped.ogImageUrl ?? scraped.metadata.thumbnailUrl,
		publishedAt: scraped.publishedDate ?? scraped.metadata.publishedAt,
	};
	const platformMetadata = buildMetadata('youtube', youtubeMetadata);

	const duration = youtubeMetadata.duration;
	if (duration && parseDurationSeconds(duration) < SHORTS_MAX_SECONDS) {
		console.info({ tag: 'YOUTUBE-CRON', msg: 'Skipping short', videoId, duration });
		return false;
	}

	const articleId = await insertArticle(db, {
		url,
		title: scraped.title,
		source: channel.name,
		publishedDate: scraped.publishedDate || new Date().toISOString(),
		summary: scraped.summary || '',
		sourceType: 'youtube',
		content: scraped.content || null,
		ogImageUrl: scraped.ogImageUrl || null,
		platformMetadata,
	});
	if (!articleId) return false;

	if (scraped.youtubeTranscript) await upsertYoutubeTranscript(db, scraped.youtubeTranscript);
	await enqueueArticleProcess(env, articleId);
	console.info({ tag: 'YOUTUBE-CRON', msg: 'Inserted video', channel: channel.name, title: scraped.title.slice(0, 60) });
	return true;
}

async function processYouTubeChannel(
	db: Awaited<ReturnType<typeof createDbClient>>,
	env: Env,
	channel: RSSFeed,
	parser: XMLParser,
): Promise<number> {
	if (!channel.RSSLink) return 0;
	const videos = await fetchChannelVideos(channel, parser);
	if (!videos?.length) return 0;

	const videoUrls = videos.map(({ url }) => url);
	const existingSet = await getExistingUrls(db, videoUrls);
	const newVideos = videos.filter(({ url }) => !existingSet.has(url));

	if (!newVideos.length) {
		console.info({ tag: 'YOUTUBE-CRON', msg: 'No new videos', channel: channel.name });
		return 0;
	}

	let inserted = 0;
	for (const video of newVideos) {
		try {
			if (await processYouTubeVideo(db, env, channel, video)) inserted++;
		} catch (err) {
			console.warn({ tag: 'YOUTUBE-CRON', msg: 'Video process failed', videoId: video.videoId, error: String(err) });
		}
	}

	await db.query(`UPDATE "RssList" SET scraped_at = $1 WHERE id = $2`, [new Date(), channel.id]);
	return inserted;
}

export async function handleYouTubeCron(env: Env, _ctx: ExecutionContext): Promise<void> {
	if (!env.YOUTUBE_API_KEY) {
		console.info({ tag: 'YOUTUBE-CRON', msg: 'Skipped — YOUTUBE_API_KEY not configured' });
		return;
	}
	console.info({ tag: 'YOUTUBE-CRON', msg: 'start' });
	const db = await createDbClient(env);
	try {
		const result = await db.query(`SELECT id, name, "RSSLink", url, type, scraped_at, avatar_url FROM "RssList" WHERE type = $1`, [
			'youtube_channel',
		]);
		const channels = result.rows as RSSFeed[];
		if (!channels.length) {
			console.info({ tag: 'YOUTUBE-CRON', msg: 'No youtube_channel entries in RssList' });
			return;
		}

		const parser = new XMLParser({ ignoreAttributes: false });
		let totalInserted = 0;
		for (const channel of channels) {
			try {
				totalInserted += await processYouTubeChannel(db, env, channel, parser);
			} catch (err) {
				console.error({ tag: 'YOUTUBE-CRON', msg: 'Channel failed', channel: channel.name, error: String(err) });
			}
		}
		console.info({ tag: 'YOUTUBE-CRON', msg: 'end', inserted: totalInserted, channels: channels.length });
	} finally {
		await db.end();
	}
}
