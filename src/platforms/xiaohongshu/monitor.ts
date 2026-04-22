// ─────────────────────────────────────────────────────────────
// Xiaohongshu User Monitor
// ─────────────────────────────────────────────────────────────

import { distributeNonDefaultArticles } from '../../domain/distribute';
import type { DbClient } from '../../infra/db';
import { createDbClient, enqueueArticleProcess, getExistingUrls, insertArticle } from '../../infra/db';
import { logError, logInfo, logWarn } from '../../infra/log';
import { normalizeUrl } from '../../infra/web';
import type { Env, ExecutionContext, RSSFeed } from '../../models/types';
import { buildXiaohongshu } from './metadata';
import type { XhsNote } from './scraper';
import { scrapeXiaohongshuUser } from './scraper';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function noteUrl(uid: string, noteId: string): string {
	return normalizeUrl(`https://www.xiaohongshu.com/user/profile/${uid}/${noteId}`);
}

async function insertNote(db: DbClient, env: Env, note: XhsNote, feed: RSSFeed, nickname: string): Promise<boolean> {
	const url = noteUrl(feed.RSSLink, note.noteId);
	const authorName = note.user?.nickname || nickname || feed.name;

	const platformMetadata = buildXiaohongshu({
		uid: feed.RSSLink,
		authorName,
		noteId: note.noteId,
		coverUrl: note.coverUrl || undefined,
		likeCount: note.likeCount,
	});

	const articleId = await insertArticle(db, {
		url,
		title: note.displayTitle || `Xiaohongshu Note ${note.noteId}`,
		source: feed.name,
		publishedDate: new Date().toISOString(),
		summary: '',
		sourceType: 'xiaohongshu',
		content: null,
		ogImageUrl: note.coverUrl || null,
		platformMetadata,
	});

	if (!articleId) return false;

	await enqueueArticleProcess(env, articleId, 'xiaohongshu');
	logInfo('XHS-CRON', 'Inserted note', { user: feed.name, title: (note.displayTitle || note.noteId).slice(0, 60) });
	return true;
}

// ─────────────────────────────────────────────────────────────
// Cron Handler
// ─────────────────────────────────────────────────────────────

export async function handleXiaohongshuCron(env: Env, _ctx: ExecutionContext): Promise<void> {
	logInfo('XHS-CRON', 'start');
	const db = await createDbClient(env);
	try {
		const result = await db.query(
			`SELECT id, name, "RSSLink", url, type, scraped_at FROM "RssList" WHERE type = $1 AND is_default = true`,
			['xiaohongshu_user'],
		);
		const users = result.rows as RSSFeed[];
		if (!users.length) {
			logInfo('XHS-CRON', 'No xiaohongshu_user entries in RssList');
			return;
		}

		let totalInserted = 0;

		for (const feed of users) {
			if (!feed.RSSLink) continue;
			try {
				const userData = await scrapeXiaohongshuUser(feed.RSSLink);
				if (!userData.notes.length) {
					logInfo('XHS-CRON', 'No notes found', { user: feed.name });
					continue;
				}

				const allUrls = userData.notes.map((n) => noteUrl(feed.RSSLink, n.noteId));
				const existingSet = await getExistingUrls(db, allUrls);
				const newNotes = userData.notes.filter((n) => !existingSet.has(noteUrl(feed.RSSLink, n.noteId)));

				if (!newNotes.length) {
					logInfo('XHS-CRON', 'All notes already exist', { user: feed.name });
					continue;
				}

				for (const note of newNotes) {
					try {
						if (await insertNote(db, env, note, feed, userData.nickname)) totalInserted++;
					} catch (err) {
						logWarn('XHS-CRON', 'Note insert failed', { noteId: note.noteId, error: String(err) });
					}
				}

				await db.query(`UPDATE "RssList" SET scraped_at = $1 WHERE id = $2`, [new Date(), feed.id]);
			} catch (err) {
				logError('XHS-CRON', 'User failed', { user: feed.name, error: String(err) });
			}
		}

		await distributeNonDefaultArticles(db, 'xiaohongshu_user');
		logInfo('XHS-CRON', 'end', { inserted: totalInserted, users: users.length });
	} finally {
		await db.end();
	}
}
