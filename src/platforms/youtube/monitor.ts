import { XMLParser } from 'fast-xml-parser';
import { createDbClient, enqueueArticleProcess, getExistingUrls, insertArticle, upsertYoutubeTranscript } from '../../infra/db';
import { fetchWithTimeout } from '../../infra/fetch';
import { logError, logInfo, logWarn } from '../../infra/log';
import { normalizeUrl } from '../../infra/web';
import { parsePlatformMetadata } from '../../models/platform-metadata-parser';
import type { Env, ExecutionContext, RSSFeed } from '../../models/types';
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
	'yt:videoId': string;
	title: string;
	published: string;
	updated?: string;
	author?: { name?: string };
	'media:group'?: {
		'media:thumbnail'?: { '@_url'?: string };
		'media:description'?: string;
	};
	link?: { '@_href'?: string } | string;
}

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

export async function handleYouTubeCron(env: Env, _ctx: ExecutionContext): Promise<void> {
	if (!env.YOUTUBE_API_KEY) {
		logInfo('YOUTUBE-CRON', 'Skipped — YOUTUBE_API_KEY not configured');
		return;
	}
	logInfo('YOUTUBE-CRON', 'start');
	const db = await createDbClient(env);
	try {
		const result = await db.query(`SELECT id, name, "RSSLink", url, type, scraped_at, avatar_url FROM "RssList" WHERE type = $1`, [
			'youtube_channel',
		]);
		const channels = result.rows as RSSFeed[];
		if (!channels.length) {
			logInfo('YOUTUBE-CRON', 'No youtube_channel entries in RssList');
			return;
		}

		const parser = new XMLParser({ ignoreAttributes: false });
		let totalInserted = 0;

		for (const channel of channels) {
			if (!channel.RSSLink) continue;
			try {
				// Fetch YouTube Atom feed
				const res = await fetchWithTimeout(channel.RSSLink, {
					headers: { 'User-Agent': USER_AGENT },
				});
				if (!res.ok) {
					logWarn('YOUTUBE-CRON', 'Feed fetch failed', { channel: channel.name, status: res.status });
					continue;
				}

				const xml = await res.text();
				const feed = parser.parse(xml);
				const rawEntries = feed?.feed?.entry;
				const entries: YouTubeAtomEntry[] = rawEntries ? (Array.isArray(rawEntries) ? rawEntries : [rawEntries]) : [];

				if (!entries.length) continue;

				// Dedup: check which video URLs already exist
				const videoUrls = entries.map((e) => normalizeUrl(`https://www.youtube.com/watch?v=${e['yt:videoId']}`));
				const existingSet = await getExistingUrls(db, videoUrls);

				const newEntries = entries.filter((e) => !existingSet.has(normalizeUrl(`https://www.youtube.com/watch?v=${e['yt:videoId']}`)));

				if (!newEntries.length) {
					logInfo('YOUTUBE-CRON', 'No new videos', { channel: channel.name });
					continue;
				}

				// Process each new video
				for (const entry of newEntries) {
					const videoId = entry['yt:videoId'];
					try {
						const scraped = await scrapeYouTube(videoId, env.YOUTUBE_API_KEY || '');
						const platformMetadata = parsePlatformMetadata(
							{
								...scraped.metadata,
								type: 'youtube',
								videoId,
								channelName: scraped.author || channel.name,
								thumbnailUrl: scraped.ogImageUrl ?? scraped.metadata?.thumbnailUrl,
								publishedAt: scraped.publishedDate ?? scraped.metadata?.publishedAt,
							},
							'youtube',
						);
						const youtubeMetadata = platformMetadata?.type === 'youtube' ? platformMetadata.data : null;

						// Skip Shorts (< 3 minutes — YouTube Shorts max is 3 min)
						const duration = youtubeMetadata?.duration;
						if (duration && parseDurationSeconds(duration) < 180) {
							logInfo('YOUTUBE-CRON', 'Skipping short', { videoId, duration });
							continue;
						}

						const url = normalizeUrl(`https://www.youtube.com/watch?v=${videoId}`);

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

						if (!articleId) continue;

						// Save transcript
						if (scraped.youtubeTranscript) {
							await upsertYoutubeTranscript(db, scraped.youtubeTranscript);
						}

						// Queue for AI processing
						await enqueueArticleProcess(env, articleId, 'youtube');

						totalInserted++;
						logInfo('YOUTUBE-CRON', 'Inserted video', { channel: channel.name, title: scraped.title.slice(0, 60) });

						// Backfill channel avatar on RssList if missing
						const avatar = youtubeMetadata?.channelAvatar;
						if (avatar && !channel.avatar_url) {
							await db.query(`UPDATE "RssList" SET avatar_url = $1 WHERE id = $2`, [avatar, channel.id]);
							channel.avatar_url = avatar;
						}
					} catch (err) {
						logWarn('YOUTUBE-CRON', 'Video process failed', { videoId, error: String(err) });
					}
				}

				// Update scraped_at
				await db.query(`UPDATE "RssList" SET scraped_at = $1 WHERE id = $2`, [new Date(), channel.id]);
			} catch (err) {
				logError('YOUTUBE-CRON', 'Channel failed', { channel: channel.name, error: String(err) });
			}
		}

		logInfo('YOUTUBE-CRON', 'end', { inserted: totalInserted, channels: channels.length });
	} finally {
		await db.end();
	}
}
