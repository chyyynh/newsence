import { ARTICLES_TABLE, createDbClient, USER_ARTICLES_TABLE } from '../../infra/db';
import { logError } from '../../infra/log';
import type { Env } from '../../models/types';
import { checkOrgMembership, isBotAuthorized } from '../middleware/auth';
import { getOrCreateUnsortedCollection } from './submit';

// ─────────────────────────────────────────────────────────────
// Telegram account lookup
// ─────────────────────────────────────────────────────────────

export async function handleTelegramLookup(request: Request, env: Env): Promise<Response> {
	if (!(await isBotAuthorized(request, env))) {
		return Response.json({ found: false, error: 'Unauthorized' }, { status: 401 });
	}

	let body: { telegramId?: string };
	try {
		body = (await request.json()) as { telegramId?: string };
	} catch {
		return Response.json({ found: false, error: 'Invalid JSON' }, { status: 400 });
	}

	if (!body.telegramId) {
		return Response.json({ found: false, error: 'Missing telegramId' }, { status: 400 });
	}

	return lookupAccountByPlatform(env, 'telegram', body.telegramId);
}

// ─────────────────────────────────────────────────────────────
// Telegram: fetch user collections
// ─────────────────────────────────────────────────────────────

export async function handleTelegramCollections(request: Request, env: Env): Promise<Response> {
	if (!(await isBotAuthorized(request, env))) {
		return Response.json({ collections: [], error: 'Unauthorized' }, { status: 401 });
	}

	let body: { userId?: string };
	try {
		body = (await request.json()) as { userId?: string };
	} catch {
		return Response.json({ collections: [], error: 'Invalid JSON' }, { status: 400 });
	}

	if (!body.userId) {
		return Response.json({ collections: [], error: 'Missing userId' }, { status: 400 });
	}

	const db = await createDbClient(env);
	try {
		const result = await db.query(
			`SELECT id, name, icon
			FROM collections
			WHERE user_id = $1
			ORDER BY updated_at DESC
			LIMIT 10`,
			[body.userId],
		);

		const collections = (result.rows ?? []).map((c: Record<string, unknown>) => ({
			id: c.id,
			name: c.name,
			icon: c.icon,
		}));

		return Response.json({ collections });
	} catch (err) {
		logError('TELEGRAM', 'Collections query error', { error: String(err) });
		return Response.json({ collections: [] });
	} finally {
		await db.end();
	}
}

// ─────────────────────────────────────────────────────────────
// Telegram: add article to collection
// ─────────────────────────────────────────────────────────────

export async function handleTelegramAddToCollection(request: Request, env: Env): Promise<Response> {
	if (!(await isBotAuthorized(request, env))) {
		return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
	}

	let body: { userId?: string; articleId?: string; collectionId?: string; toType?: string };
	try {
		body = (await request.json()) as { userId?: string; articleId?: string; collectionId?: string; toType?: string };
	} catch {
		return Response.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
	}

	const { userId, articleId, collectionId } = body;
	const toType = body.toType === 'user_article' ? 'user_article' : 'article';
	if (!userId || !articleId || !collectionId) {
		return Response.json({ success: false, error: 'Missing required fields' }, { status: 400 });
	}

	const db = await createDbClient(env);
	try {
		// Ensure the target collection belongs to the requesting user.
		const collectionResult = await db.query(`SELECT id FROM collections WHERE id = $1 AND user_id = $2`, [collectionId, userId]);
		const ownedCollection = collectionResult.rows[0] ?? null;

		if (!ownedCollection) {
			return Response.json({ success: false, error: 'Invalid collection for user' }, { status: 403 });
		}

		// Verify article exists in the correct table
		const lookupTable = toType === 'user_article' ? USER_ARTICLES_TABLE : ARTICLES_TABLE;
		const articleResult = await db.query(`SELECT id FROM ${lookupTable} WHERE id = $1`, [articleId]);
		const articleExists = articleResult.rows[0] ?? null;
		if (!articleExists) {
			return Response.json({ success: false, error: 'Article not found' }, { status: 404 });
		}

		// Check if already exists
		const existingResult = await db.query(
			`SELECT id FROM citations WHERE from_type = $1 AND from_id = $2 AND to_type = $3 AND to_id = $4 AND user_id = $5`,
			['collection', collectionId, toType, articleId, userId],
		);
		const existing = existingResult.rows[0];

		if (existing) {
			return Response.json({ success: false, error: 'already_exists' });
		}

		// Insert citation — articleCount is maintained by DB trigger
		await db.query(
			`INSERT INTO citations (from_type, from_id, to_type, to_id, relation_type, user_id)
			VALUES ($1, $2, $3, $4, $5, $6)`,
			['collection', collectionId, toType, articleId, 'resource', userId],
		);

		return Response.json({ success: true });
	} catch (err) {
		logError('TELEGRAM', 'Add to collection failed', { error: String(err) });
		return Response.json({ success: false, error: 'Insert failed' }, { status: 500 });
	} finally {
		await db.end();
	}
}

// ─────────────────────────────────────────────────────────────
// List articles (for bot export)
// ─────────────────────────────────────────────────────────────

export async function handleBotListArticles(request: Request, env: Env): Promise<Response> {
	if (!(await isBotAuthorized(request, env))) {
		return Response.json({ articles: [], error: 'Unauthorized' }, { status: 401 });
	}

	let body: { userId?: string; period?: string; organizationId?: string };
	try {
		body = (await request.json()) as { userId?: string; period?: string; organizationId?: string };
	} catch {
		return Response.json({ articles: [] }, { status: 400 });
	}

	if (!body.userId) {
		return Response.json({ articles: [], error: 'Missing userId' }, { status: 400 });
	}

	const period = body.period || 'unsorted';
	const orgId = body.organizationId || null;
	const db = await createDbClient(env);

	try {
		// Validate org membership using the same connection
		if (orgId) {
			const isMember = await checkOrgMembership(db, body.userId, orgId);
			if (!isMember) {
				return Response.json({ articles: [], error: 'Not a member of this organization' }, { status: 403 });
			}
		}

		let dateFilter = '';
		if (period === 'week') {
			dateFilter = `AND scraped_date >= NOW() - INTERVAL '7 days'`;
		}

		// Query user_articles first, then public articles
		const cols =
			"title, COALESCE(title_cn, title) as display_title, url, source_type, COALESCE(tags, ARRAY[]::text[]) as tags, COALESCE(summary_cn, summary, '') as summary, published_date, scraped_date";

		let query: string;
		let params: unknown[];

		if (period === 'unsorted' && orgId) {
			// Unsorted = articles in the system collection for this org (both user_articles and legacy articles)
			query = `(SELECT ${cols} FROM ${USER_ARTICLES_TABLE} ua
				JOIN citations c ON c.to_type = 'user_article' AND c.to_id = ua.id::text
				JOIN collections col ON col.id = c.from_id AND col.is_system = true AND col.organization_id = $1
				WHERE c.from_type = 'collection' ${dateFilter})
				UNION ALL
				(SELECT ${cols} FROM ${ARTICLES_TABLE} a
				JOIN citations c ON c.to_type = 'article' AND c.to_id = a.id::text
				JOIN collections col ON col.id = c.from_id AND col.is_system = true AND col.organization_id = $1
				WHERE c.from_type = 'collection' ${dateFilter})
				ORDER BY scraped_date DESC LIMIT 500`;
			params = [orgId];
		} else if (period === 'unsorted') {
			query = `(SELECT ${cols} FROM ${USER_ARTICLES_TABLE} ua
				JOIN citations c ON c.to_type = 'user_article' AND c.to_id = ua.id::text
				JOIN collections col ON col.id = c.from_id AND col.is_system = true AND col.user_id = $1 AND col.organization_id IS NULL
				WHERE c.from_type = 'collection' ${dateFilter})
				UNION ALL
				(SELECT ${cols} FROM ${ARTICLES_TABLE} a
				JOIN citations c ON c.to_type = 'article' AND c.to_id = a.id::text
				JOIN collections col ON col.id = c.from_id AND col.is_system = true AND col.user_id = $1 AND col.organization_id IS NULL
				WHERE c.from_type = 'collection' ${dateFilter})
				ORDER BY scraped_date DESC LIMIT 500`;
			params = [body.userId];
		} else if (orgId) {
			query = `SELECT ${cols} FROM ${USER_ARTICLES_TABLE} WHERE organization_id = $1 ${dateFilter} ORDER BY scraped_date DESC LIMIT 500`;
			params = [orgId];
		} else {
			query = `SELECT ${cols} FROM ${USER_ARTICLES_TABLE} WHERE user_id = $1 AND organization_id IS NULL ${dateFilter} ORDER BY scraped_date DESC LIMIT 500`;
			params = [body.userId];
		}

		const result = await db.query(query, params);
		const articles = (result.rows ?? []).map((r: Record<string, unknown>) => ({
			title: (r.display_title as string) || (r.title as string) || '',
			url: (r.url as string) || '',
			sourceType: (r.source_type as string) || '',
			tags: (r.tags as string[]) || [],
			summary: (r.summary as string) || '',
			publishedDate: r.published_date ? String(r.published_date) : '',
			scrapedDate: r.scraped_date ? String(r.scraped_date) : '',
		}));

		return Response.json({ articles });
	} finally {
		await db.end();
	}
}

// ─────────────────────────────────────────────────────────────
// Get or create unsorted collection
// ─────────────────────────────────────────────────────────────

export async function handleBotGetUnsorted(request: Request, env: Env): Promise<Response> {
	if (!(await isBotAuthorized(request, env))) {
		return Response.json({ error: 'Unauthorized' }, { status: 401 });
	}

	let body: { userId?: string; organizationId?: string };
	try {
		body = (await request.json()) as { userId?: string; organizationId?: string };
	} catch {
		return Response.json({ error: 'Invalid JSON' }, { status: 400 });
	}

	if (!body.userId) {
		return Response.json({ error: 'Missing userId' }, { status: 400 });
	}

	const db = await createDbClient(env);
	try {
		const orgId = body.organizationId || null;

		if (orgId) {
			const isMember = await checkOrgMembership(db, body.userId, orgId);
			if (!isMember) {
				return Response.json({ error: 'Not a member of this organization' }, { status: 403 });
			}
		}

		const collectionId = await getOrCreateUnsortedCollection(db, body.userId, orgId);
		return Response.json({ collectionId });
	} finally {
		await db.end();
	}
}

// ─────────────────────────────────────────────────────────────
// Generic bot account lookup (supports any platform)
// ─────────────────────────────────────────────────────────────

async function lookupAccountByPlatform(env: Env, platform: string, externalId: string): Promise<Response> {
	const db = await createDbClient(env);
	try {
		const result = await db.query(`SELECT "userId" FROM account WHERE "providerId" = $1 AND "accountId" = $2`, [
			platform,
			externalId,
		]);
		const data = result.rows[0];
		if (!data) return Response.json({ found: false });
		return Response.json({ found: true, userId: data.userId });
	} finally {
		await db.end();
	}
}

export async function handleBotLookup(request: Request, env: Env): Promise<Response> {
	if (!(await isBotAuthorized(request, env))) {
		return Response.json({ found: false, error: 'Unauthorized' }, { status: 401 });
	}

	let body: { platform?: string; externalId?: string };
	try {
		body = (await request.json()) as { platform?: string; externalId?: string };
	} catch {
		return Response.json({ found: false, error: 'Invalid JSON' }, { status: 400 });
	}

	if (!body.platform || !body.externalId) {
		return Response.json({ found: false, error: 'Missing platform or externalId' }, { status: 400 });
	}

	return lookupAccountByPlatform(env, body.platform, body.externalId);
}
