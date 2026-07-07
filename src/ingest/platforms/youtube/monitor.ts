import { getExistingArticlesByUrl } from '@core-shared/article-store';
import { FEED_UA, fetchWithTimeout, normalizeUrl, readTextWithLimit } from '@core-shared/web';
import { extractFromXml, type FeedEntry } from '@extractus/feed-extractor';
import { startSourceArticleWorkflow } from '@ingest/workflow';
import { Client } from 'pg';
import { parseDurationSeconds, scrapeYouTube } from './scraper';

interface YouTubeFeedVideo {
	videoId: string;
	url: string;
}
type YouTubeFeedEntry = FeedEntry & { videoId?: unknown };
type YouTubeChannelSource = {
	id: string;
	name: string;
	RSSLink: string | null;
};

const SHORTS_MAX_SECONDS = 180;
const MAX_FEED_BYTES = 1024 * 1024;
const SOURCE_FEED_FIELDS = 'id, name, "RSSLink"';

function parseFeedVideos(xml: string): YouTubeFeedVideo[] {
	const entries = (extractFromXml(xml, {
		descriptionMaxLen: 0,
		getExtraEntryFields: (entry) => ({ videoId: entry['yt:videoId'] }),
	}).entries ?? []) as YouTubeFeedEntry[];

	return entries.flatMap((entry) =>
		typeof entry.videoId === 'string'
			? [{ videoId: entry.videoId, url: normalizeUrl(entry.link ?? `https://youtube.com/watch?v=${entry.videoId}`) }]
			: [],
	);
}

export async function handleYouTubeCron(env: Env): Promise<void> {
	if (!env.YOUTUBE_API_KEY) {
		console.info({ tag: 'YOUTUBE-CRON', msg: 'Skipped — YOUTUBE_API_KEY not configured' });
		return;
	}
	console.info({ tag: 'YOUTUBE-CRON', msg: 'start' });
	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	const channels = (
		await db.query<YouTubeChannelSource>(`SELECT ${SOURCE_FEED_FIELDS} FROM "RssList" WHERE type = $1`, ['youtube_channel'])
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
				try {
					const scraped = await scrapeYouTube(video.videoId, env.YOUTUBE_API_KEY, {
						minDurationSecondsForTranscript: SHORTS_MAX_SECONDS,
					});
					const youtubeMetadata = scraped.metadata.data;
					const duration = youtubeMetadata.duration;
					if (duration && parseDurationSeconds(duration) < SHORTS_MAX_SECONDS) {
						console.info({ tag: 'YOUTUBE-CRON', msg: 'Skipping short', videoId: video.videoId, duration });
						continue;
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
							platformMetadata: scraped.metadata,
						},
						...(scraped.youtubeTranscript
							? { attachments: [{ kind: 'youtube-transcript' as const, transcript: scraped.youtubeTranscript }] }
							: {}),
					});
					totalQueued++;
					console.info({ tag: 'YOUTUBE-CRON', msg: 'Started video workflow', channel: channel.name, title: scraped.title.slice(0, 60) });
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
