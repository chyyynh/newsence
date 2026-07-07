import { getExistingUrls } from '@core-shared/article-store';
import type { YouTubeMetadata } from '@core-shared/platform-metadata';
import type { RSSFeed } from '@core-shared/types';
import { FEED_UA, fetchWithTimeout, readTextWithLimit } from '@core-shared/web';
import { startSourceArticleWorkflow } from '@ingest/workflows/queue';
import { XMLParser } from 'fast-xml-parser';
import { Client } from 'pg';
import { parseDurationSeconds, scrapeYouTube } from './scraper';

// ─────────────────────────────────────────────────────────────
// YouTube Channel Monitor
// ─────────────────────────────────────────────────────────────

interface YouTubeAtomEntry {
	'yt:videoId'?: string;
}

interface YouTubeFeedVideo {
	videoId: string;
	url: string;
}

const SHORTS_MAX_SECONDS = 180;
const MAX_FEED_BYTES = 1024 * 1024;
const SOURCE_FEED_FIELDS = 'id, name, "RSSLink", url, type, scraped_at, avatar_url';

async function queueYouTubeVideo(env: Env, apiKey: string, channel: RSSFeed, video: YouTubeFeedVideo): Promise<boolean> {
	const scraped = await scrapeYouTube(video.videoId, apiKey, { minDurationSecondsForTranscript: SHORTS_MAX_SECONDS });
	const youtubeMetadata: YouTubeMetadata = {
		...scraped.metadata.data,
		videoId: video.videoId,
	};
	const duration = youtubeMetadata.duration;
	if (duration && parseDurationSeconds(duration) < SHORTS_MAX_SECONDS) {
		console.info({ tag: 'YOUTUBE-CRON', msg: 'Skipping short', videoId: video.videoId, duration });
		return false;
	}

	await startSourceArticleWorkflow(env, {
		article: {
			url: video.url,
			title: scraped.title,
			source: youtubeMetadata.channelName,
			publishedDate: scraped.publishedDate as string,
			summary: scraped.summary ?? '',
			sourceType: 'youtube',
			content: scraped.content,
			ogImageUrl: scraped.ogImageUrl,
			platformMetadata: { type: 'youtube', fetchedAt: new Date().toISOString(), data: youtubeMetadata },
		},
		...(scraped.youtubeTranscript ? { attachments: [{ kind: 'youtube-transcript' as const, transcript: scraped.youtubeTranscript }] } : {}),
	});
	console.info({ tag: 'YOUTUBE-CRON', msg: 'Started video workflow', channel: channel.name, title: scraped.title.slice(0, 60) });
	return true;
}

export async function handleYouTubeCron(env: Env): Promise<void> {
	if (!env.YOUTUBE_API_KEY) {
		console.info({ tag: 'YOUTUBE-CRON', msg: 'Skipped — YOUTUBE_API_KEY not configured' });
		return;
	}
	console.info({ tag: 'YOUTUBE-CRON', msg: 'start' });
	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	const channels = (await db.query<RSSFeed>(`SELECT ${SOURCE_FEED_FIELDS} FROM "RssList" WHERE type = $1`, ['youtube_channel'])).rows;

	const parser = new XMLParser({ ignoreAttributes: false });
	let totalQueued = 0;
	for (const channel of channels) {
		try {
			if (!channel.RSSLink) continue;
			const res = await fetchWithTimeout(channel.RSSLink, { headers: { 'User-Agent': FEED_UA } });
			if (!res.ok) {
				console.warn({ tag: 'YOUTUBE-CRON', msg: 'Feed fetch failed', channel: channel.name, status: res.status });
				continue;
			}

			const feed = parser.parse(await readTextWithLimit(res, MAX_FEED_BYTES));
			const rawEntries = feed?.feed?.entry;
			const videos = rawEntries
				? ((Array.isArray(rawEntries) ? rawEntries : [rawEntries]) as YouTubeAtomEntry[])
						.map((entry) => entry['yt:videoId'])
						.filter((videoId): videoId is string => !!videoId)
						.map((videoId) => ({ videoId, url: `https://youtube.com/watch?v=${videoId}` }))
				: [];
			if (videos.length === 0) {
				console.info({ tag: 'YOUTUBE-CRON', msg: 'Feed has no videos', channel: channel.name });
				await db.query(`UPDATE "RssList" SET scraped_at = $1 WHERE id = $2`, [new Date(), channel.id]);
				continue;
			}

			const videoUrls = videos.map(({ url }) => url);
			const existingSet = await getExistingUrls(db, videoUrls);
			const newVideos = videos.filter(({ url }) => !existingSet.has(url));

			if (!newVideos.length) {
				console.info({ tag: 'YOUTUBE-CRON', msg: 'No new videos', channel: channel.name });
			}

			for (const video of newVideos) {
				try {
					if (await queueYouTubeVideo(env, env.YOUTUBE_API_KEY, channel, video)) totalQueued++;
				} catch (err) {
					console.warn({ tag: 'YOUTUBE-CRON', msg: 'Video process failed', videoId: video.videoId, error: String(err) });
				}
			}

			await db.query(`UPDATE "RssList" SET scraped_at = $1 WHERE id = $2`, [new Date(), channel.id]);
		} catch (err) {
			console.error({ tag: 'YOUTUBE-CRON', msg: 'Channel failed', channel: channel.name, error: String(err) });
		}
	}
	console.info({ tag: 'YOUTUBE-CRON', msg: 'end', queued: totalQueued, channels: channels.length });
}
