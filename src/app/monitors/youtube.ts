import { XMLParser } from 'fast-xml-parser';
import { scrapeYouTube } from '../../domain/scrapers';
import { ARTICLES_TABLE, createDbClient } from '../../infra/db';
import { logError, logInfo, logWarn } from '../../infra/log';
import { normalizeUrl } from '../../infra/web';
import { buildYouTube } from '../../models/platform-metadata';
import type { Env, ExecutionContext, RSSFeed } from '../../models/types';
import { distributeNonDefaultArticles } from './rss';

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
		const table = ARTICLES_TABLE;
		let totalInserted = 0;

		for (const channel of channels) {
			if (!channel.RSSLink) continue;
			try {
				// Fetch YouTube Atom feed
				const res = await fetch(channel.RSSLink, {
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
				const existing = await db.query(`SELECT url FROM ${table} WHERE url = ANY($1)`, [videoUrls]);
				const existingSet = new Set((existing.rows as { url: string }[]).map((r) => normalizeUrl(r.url)));

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

						// Skip Shorts (< 3 minutes — YouTube Shorts max is 3 min)
						const duration = scraped.metadata?.duration as string | undefined;
						if (duration && parseDurationSeconds(duration) < 180) {
							logInfo('YOUTUBE-CRON', 'Skipping short', { videoId, duration });
							continue;
						}

						const url = normalizeUrl(`https://www.youtube.com/watch?v=${videoId}`);

						const platformMetadata = buildYouTube({
							videoId,
							channelName: scraped.author || channel.name,
							channelId: (scraped.metadata?.channelId as string) || undefined,
							channelAvatar: (scraped.metadata?.channelAvatar as string) || undefined,
							duration: (scraped.metadata?.duration as string) || undefined,
							thumbnailUrl: scraped.ogImageUrl || undefined,
							viewCount: scraped.metadata?.viewCount as number | undefined,
							likeCount: scraped.metadata?.likeCount as number | undefined,
							commentCount: scraped.metadata?.commentCount as number | undefined,
							publishedAt: scraped.publishedDate || undefined,
							description: (scraped.metadata?.description as string) || undefined,
							tags: (scraped.metadata?.tags as string[]) || undefined,
						});

						const insertResult = await db.query(
							`INSERT INTO ${table}
								(url, title, source, published_date, scraped_date, summary, source_type, content, og_image_url, keywords, tags, tokens, platform_metadata)
							VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
							ON CONFLICT (url) DO NOTHING
							RETURNING id`,
							[
								url,
								scraped.title,
								channel.name,
								scraped.publishedDate || new Date().toISOString(),
								new Date().toISOString(),
								scraped.summary || '',
								'youtube',
								scraped.content || null,
								scraped.ogImageUrl || null,
								[],
								[],
								[],
								JSON.stringify(platformMetadata),
							],
						);

						const articleId = insertResult.rows[0]?.id;
						if (!articleId) continue;

						// Save transcript
						if (scraped.youtubeTranscript) {
							const yt = scraped.youtubeTranscript;
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
									yt.videoId,
									JSON.stringify(yt.segments),
									yt.language,
									yt.chapters ? JSON.stringify(yt.chapters) : null,
									yt.chaptersFromDescription,
									new Date().toISOString(),
								],
							);
						}

						// Queue for AI processing
						await env.ARTICLE_QUEUE.send({
							type: 'article_process',
							article_id: articleId,
							source_type: 'youtube',
						});

						totalInserted++;
						logInfo('YOUTUBE-CRON', 'Inserted video', { channel: channel.name, title: scraped.title.slice(0, 60) });

						// Backfill channel avatar on RssList if missing
						const avatar = scraped.metadata?.channelAvatar as string | undefined;
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

		// Distribute non-default YouTube articles to subscribers
		await distributeNonDefaultArticles(db, 'youtube_channel');

		logInfo('YOUTUBE-CRON', 'end', { inserted: totalInserted, channels: channels.length });
	} finally {
		await db.end();
	}
}
