// ─────────────────────────────────────────────────────────────
// Xiaohongshu User Monitor
// ─────────────────────────────────────────────────────────────

import { distributeNonDefaultArticles } from '../../domain/distribute';
import type { DbClient } from '../../infra/db';
import { ARTICLES_TABLE, createDbClient } from '../../infra/db';
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

async function deduplicateUrls(db: DbClient, urls: string[], table: string): Promise<Set<string>> {
	const existingSet = new Set<string>();
	for (let i = 0; i < urls.length; i += 50) {
		const chunk = urls.slice(i, i + 50);
		const existing = await db.query(`SELECT url FROM ${table} WHERE url = ANY($1)`, [chunk]);
		for (const row of existing.rows as { url: string }[]) {
			existingSet.add(normalizeUrl(row.url));
		}
	}
	return existingSet;
}

async function insertNote(db: DbClient, env: Env, note: XhsNote, feed: RSSFeed, nickname: string, table: string): Promise<boolean> {
	const url = noteUrl(feed.RSSLink, note.noteId);
	const authorName = note.user?.nickname || nickname || feed.name;

	const platformMetadata = buildXiaohongshu({
		uid: feed.RSSLink,
		authorName,
		noteId: note.noteId,
		coverUrl: note.coverUrl || undefined,
		likeCount: note.likeCount,
	});

	const insertResult = await db.query(
		`INSERT INTO ${table}
			(url, title, source, published_date, scraped_date, keywords, tags, tokens, summary, source_type, content, og_image_url, platform_metadata)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		ON CONFLICT (url) DO NOTHING
		RETURNING id`,
		[
			url,
			note.displayTitle || `Xiaohongshu Note ${note.noteId}`,
			feed.name,
			new Date().toISOString(),
			new Date().toISOString(),
			[],
			[],
			[],
			'',
			'xiaohongshu',
			null,
			note.coverUrl || null,
			JSON.stringify(platformMetadata),
		],
	);

	const articleId = insertResult.rows[0]?.id;
	if (!articleId) return false;

	await env.ARTICLE_QUEUE.send({ type: 'article_process', article_id: articleId, source_type: 'xiaohongshu' });
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

		const table = ARTICLES_TABLE;
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
				const existingSet = await deduplicateUrls(db, allUrls, table);
				const newNotes = userData.notes.filter((n) => !existingSet.has(noteUrl(feed.RSSLink, n.noteId)));

				if (!newNotes.length) {
					logInfo('XHS-CRON', 'All notes already exist', { user: feed.name });
					continue;
				}

				for (const note of newNotes) {
					try {
						if (await insertNote(db, env, note, feed, userData.nickname, table)) totalInserted++;
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
