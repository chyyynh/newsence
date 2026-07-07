import { getExistingUrls } from '@core-shared/article-store';
import { withDbClient } from '@core-shared/db';
import { buildMetadata, type YouTubeMetadata } from '@core-shared/platform-metadata';
import type { Env, RSSFeed } from '@core-shared/types';
import { FEED_UA, fetchWithTimeout, readTextWithLimit } from '@core-shared/web';
import { startSourceArticleWorkflow } from '@ingest/workflows/queue';
import { XMLParser } from 'fast-xml-parser';
import { parseDurationSeconds, scrapeYouTube } from './scraper';

// ─────────────────────────────────────────────────────────────
// YouTube Channel Monitor
// ─────────────────────────────────────────────────────────────

interface YouTubeAtomEntry {
	'yt:videoId'?: string;
}

const SHORTS_MAX_SECONDS = 180;
const MAX_FEED_BYTES = 1024 * 1024;
const SOURCE_FEED_FIELDS = 'id, name, "RSSLink", url, type, scraped_at, avatar_url';

export async function handleYouTubeCron(env: Env): Promise<void> {
	if (!env.YOUTUBE_API_KEY) {
		console.info({ tag: 'YOUTUBE-CRON', msg: 'Skipped — YOUTUBE_API_KEY not configured' });
		return;
	}
	console.info({ tag: 'YOUTUBE-CRON', msg: 'start' });
	const channels = await withDbClient(
		env,
		async (db) => (await db.query<RSSFeed>(`SELECT ${SOURCE_FEED_FIELDS} FROM "RssList" WHERE type = $1`, ['youtube_channel'])).rows,
	);
	if (!channels.length) {
		console.info({ tag: 'YOUTUBE-CRON', msg: 'No youtube_channel source feeds configured' });
		return;
	}

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
				await withDbClient(env, (db) => db.query(`UPDATE "RssList" SET scraped_at = $1 WHERE id = $2`, [new Date(), channel.id]));
				continue;
			}

			const videoUrls = videos.map(({ url }) => url);
			const existingSet = await withDbClient(env, (db) => getExistingUrls(db, videoUrls));
			const newVideos = videos.filter(({ url }) => !existingSet.has(url));

			if (!newVideos.length) {
				console.info({ tag: 'YOUTUBE-CRON', msg: 'No new videos', channel: channel.name });
			}

			for (const { videoId, url } of newVideos) {
				try {
					const scraped = await scrapeYouTube(videoId, env.YOUTUBE_API_KEY || '', {
						minDurationSecondsForTranscript: SHORTS_MAX_SECONDS,
					});
					const youtubeMetadata: YouTubeMetadata = {
						...scraped.metadata.data,
						videoId,
						channelName: scraped.author || channel.name,
						channelAvatar: scraped.metadata.data.channelAvatar ?? channel.avatar_url,
						thumbnailUrl: scraped.ogImageUrl ?? scraped.metadata.data.thumbnailUrl,
						publishedAt: scraped.publishedDate ?? scraped.metadata.data.publishedAt,
					};
					const duration = youtubeMetadata.duration;
					if (duration && parseDurationSeconds(duration) < SHORTS_MAX_SECONDS) {
						console.info({ tag: 'YOUTUBE-CRON', msg: 'Skipping short', videoId, duration });
						continue;
					}

					await startSourceArticleWorkflow(env, {
						article: {
							url,
							title: scraped.title,
							source: channel.name,
							publishedDate: scraped.publishedDate || new Date().toISOString(),
							summary: scraped.summary || '',
							sourceType: 'youtube',
							content: scraped.content || null,
							ogImageUrl: scraped.ogImageUrl || null,
							platformMetadata: buildMetadata('youtube', youtubeMetadata),
						},
						...(scraped.youtubeTranscript
							? { attachments: [{ kind: 'youtube-transcript' as const, transcript: scraped.youtubeTranscript }] }
							: {}),
					});
					totalQueued++;
					console.info({ tag: 'YOUTUBE-CRON', msg: 'Started video workflow', channel: channel.name, title: scraped.title.slice(0, 60) });
				} catch (err) {
					console.warn({ tag: 'YOUTUBE-CRON', msg: 'Video process failed', videoId, error: String(err) });
				}
			}

			await withDbClient(env, (db) => db.query(`UPDATE "RssList" SET scraped_at = $1 WHERE id = $2`, [new Date(), channel.id]));
		} catch (err) {
			console.error({ tag: 'YOUTUBE-CRON', msg: 'Channel failed', channel: channel.name, error: String(err) });
		}
	}
	console.info({ tag: 'YOUTUBE-CRON', msg: 'end', queued: totalQueued, channels: channels.length });
}
