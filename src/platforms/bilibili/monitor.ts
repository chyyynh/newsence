// ─────────────────────────────────────────────────────────────
// Bilibili User Dynamic Monitor
// ─────────────────────────────────────────────────────────────

import { distributeNonDefaultArticles } from '../../domain/distribute';
import type { DbClient } from '../../infra/db';
import { createDbClient, enqueueArticleProcess, getExistingUrls, insertArticle } from '../../infra/db';
import { logError, logInfo, logWarn } from '../../infra/log';
import { normalizeUrl } from '../../infra/web';
import type { Env, ExecutionContext, RSSFeed } from '../../models/types';
import { getDynSpace } from './grpc';
import { buildBilibili } from './metadata';
import type { ParsedDynamic } from './parser';
import { parseVideoCards } from './parser';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

async function insertVideo(db: DbClient, env: Env, video: ParsedDynamic, feed: RSSFeed): Promise<boolean> {
	const url = normalizeUrl(video.url);
	const platformMetadata = buildBilibili({
		uid: feed.RSSLink,
		authorName: video.author || feed.name,
		cardType: video.cardType,
		dynamicId: video.dynamicId,
		coverUrl: video.imageUrl || undefined,
	});

	const articleId = await insertArticle(db, {
		url,
		title: video.title,
		source: feed.name,
		publishedDate: video.publishedDate,
		summary: '',
		sourceType: 'bilibili',
		content: video.description || null,
		ogImageUrl: video.imageUrl || null,
		platformMetadata,
	});

	if (!articleId) return false;

	await enqueueArticleProcess(env, articleId, 'bilibili');
	logInfo('BILIBILI-CRON', 'Inserted video', { user: feed.name, title: video.title.slice(0, 60) });
	return true;
}

// ─────────────────────────────────────────────────────────────
// Cron Handler
// ─────────────────────────────────────────────────────────────

export async function handleBilibiliCron(env: Env, _ctx: ExecutionContext): Promise<void> {
	logInfo('BILIBILI-CRON', 'start');
	const db = await createDbClient(env);
	try {
		const result = await db.query(
			`SELECT id, name, "RSSLink", url, type, scraped_at FROM "RssList" WHERE type = $1 AND is_default = true`,
			['bilibili_user'],
		);
		const users = result.rows as RSSFeed[];
		if (!users.length) {
			logInfo('BILIBILI-CRON', 'No bilibili_user entries in RssList');
			return;
		}

		let totalInserted = 0;

		for (const feed of users) {
			if (!feed.RSSLink) continue;
			try {
				const jsonStr = await getDynSpace(feed.RSSLink);
				const videos = parseVideoCards(jsonStr);

				if (!videos.length) {
					logInfo('BILIBILI-CRON', 'No new video dynamics', { user: feed.name });
					continue;
				}

				const allUrls = videos.map((v) => normalizeUrl(v.url));
				const existingSet = await getExistingUrls(db, allUrls);
				const newVideos = videos.filter((v) => !existingSet.has(normalizeUrl(v.url)));

				if (!newVideos.length) {
					logInfo('BILIBILI-CRON', 'All videos already exist', { user: feed.name });
					continue;
				}

				for (const video of newVideos) {
					try {
						if (await insertVideo(db, env, video, feed)) totalInserted++;
					} catch (err) {
						logWarn('BILIBILI-CRON', 'Video insert failed', { url: video.url, error: String(err) });
					}
				}

				await db.query(`UPDATE "RssList" SET scraped_at = $1 WHERE id = $2`, [new Date(), feed.id]);
			} catch (err) {
				logError('BILIBILI-CRON', 'User failed', { user: feed.name, error: String(err) });
			}
		}

		await distributeNonDefaultArticles(db, 'bilibili_user');
		logInfo('BILIBILI-CRON', 'end', { inserted: totalInserted, users: users.length });
	} finally {
		await db.end();
	}
}
