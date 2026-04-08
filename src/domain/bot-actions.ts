/**
 * Bot actions — pure async functions invoked by both the bot worker (via RPC
 * service binding) and any HTTP entry points that still need them.
 *
 * No `Request`/`Response` here — these are typed inputs/outputs so they can be
 * called directly through Workers RPC. Authorization is the caller's job:
 * RPC traffic is gated by the service binding itself, not by a header check.
 */

import { getOrCreateUnsortedCollection } from '../app/handlers/submit';
import { checkOrgMembership } from '../app/middleware/auth';
import { ARTICLES_TABLE, createDbClient, USER_ARTICLES_TABLE } from '../infra/db';
import { logError } from '../infra/log';
import type { Env } from '../models/types';

// ── Shared types ──────────────────────────────────────────────

export type AccountLookupResult = { found: boolean; userId?: string };

export type CollectionItem = {
	id: string;
	name: string;
	icon: string | null;
};

export type AddToCollectionResult = { success: boolean; error?: string };

export type GetUnsortedResult = { collectionId: string | null; error?: string };

export type ExportArticle = {
	title: string;
	url: string;
	sourceType: string;
	tags: string[];
	summary: string;
	publishedDate: string;
	scrapedDate: string;
};

export type ListArticlesResult = { articles: ExportArticle[]; error?: string };

// ── Account lookup ────────────────────────────────────────────

export async function lookupAccount(env: Env, platform: string, externalId: string): Promise<AccountLookupResult> {
	const db = await createDbClient(env);
	try {
		const result = await db.query(`SELECT "userId" FROM account WHERE "providerId" = $1 AND "accountId" = $2`, [platform, externalId]);
		const row = result.rows[0] as { userId?: string } | undefined;
		if (!row?.userId) return { found: false };
		return { found: true, userId: row.userId };
	} finally {
		await db.end();
	}
}

// ── Collections ───────────────────────────────────────────────

export async function getCollections(env: Env, userId: string): Promise<CollectionItem[]> {
	const db = await createDbClient(env);
	try {
		const result = await db.query(
			`SELECT id, name, icon
			FROM collections
			WHERE user_id = $1
			ORDER BY updated_at DESC
			LIMIT 10`,
			[userId],
		);
		return (result.rows ?? []).map((c: Record<string, unknown>) => ({
			id: c.id as string,
			name: c.name as string,
			icon: (c.icon as string | null) ?? null,
		}));
	} catch (err) {
		logError('TELEGRAM', 'Collections query error', { error: String(err) });
		return [];
	} finally {
		await db.end();
	}
}

export async function addArticleToCollection(
	env: Env,
	args: { userId: string; articleId: string; collectionId: string; toType?: string },
): Promise<AddToCollectionResult> {
	const toType = args.toType === 'user_article' ? 'user_article' : 'article';
	const db = await createDbClient(env);
	try {
		// Ensure the target collection belongs to the requesting user.
		const collectionResult = await db.query(`SELECT id FROM collections WHERE id = $1 AND user_id = $2`, [args.collectionId, args.userId]);
		if (!collectionResult.rows[0]) {
			return { success: false, error: 'Invalid collection for user' };
		}

		// Verify article exists in the correct table.
		const lookupTable = toType === 'user_article' ? USER_ARTICLES_TABLE : ARTICLES_TABLE;
		const articleResult = await db.query(`SELECT id FROM ${lookupTable} WHERE id = $1`, [args.articleId]);
		if (!articleResult.rows[0]) {
			return { success: false, error: 'Article not found' };
		}

		// Check if already exists.
		const existingResult = await db.query(
			`SELECT id FROM citations WHERE from_type = $1 AND from_id = $2 AND to_type = $3 AND to_id = $4 AND user_id = $5`,
			['collection', args.collectionId, toType, args.articleId, args.userId],
		);
		if (existingResult.rows[0]) {
			return { success: false, error: 'already_exists' };
		}

		// Insert citation — articleCount is maintained by DB trigger.
		await db.query(
			`INSERT INTO citations (from_type, from_id, to_type, to_id, relation_type, user_id)
			VALUES ($1, $2, $3, $4, $5, $6)`,
			['collection', args.collectionId, toType, args.articleId, 'resource', args.userId],
		);

		return { success: true };
	} catch (err) {
		logError('TELEGRAM', 'Add to collection failed', { error: String(err) });
		return { success: false, error: 'Insert failed' };
	} finally {
		await db.end();
	}
}

// ── Unsorted collection ───────────────────────────────────────

export async function getUnsortedCollection(env: Env, userId: string, organizationId?: string): Promise<GetUnsortedResult> {
	const db = await createDbClient(env);
	try {
		const orgId = organizationId || null;
		if (orgId) {
			const isMember = await checkOrgMembership(db, userId, orgId);
			if (!isMember) {
				return { collectionId: null, error: 'Not a member of this organization' };
			}
		}
		const collectionId = await getOrCreateUnsortedCollection(db, userId, orgId);
		return { collectionId };
	} finally {
		await db.end();
	}
}

// ── List articles for export ──────────────────────────────────

export async function listArticles(
	env: Env,
	args: { userId: string; period?: string; organizationId?: string },
): Promise<ListArticlesResult> {
	const period = args.period || 'unsorted';
	const orgId = args.organizationId || null;
	const db = await createDbClient(env);

	try {
		// Validate org membership using the same connection.
		if (orgId) {
			const isMember = await checkOrgMembership(db, args.userId, orgId);
			if (!isMember) {
				return { articles: [], error: 'Not a member of this organization' };
			}
		}

		const dateFilter = period === 'week' ? `AND scraped_date >= NOW() - INTERVAL '7 days'` : '';

		const cols =
			"title, COALESCE(title_cn, title) as display_title, url, source_type, COALESCE(tags, ARRAY[]::text[]) as tags, COALESCE(summary_cn, summary, '') as summary, published_date, scraped_date";

		let query: string;
		let params: unknown[];

		if (period === 'unsorted' && orgId) {
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
			params = [args.userId];
		} else if (orgId) {
			query = `SELECT ${cols} FROM ${USER_ARTICLES_TABLE} WHERE organization_id = $1 ${dateFilter} ORDER BY scraped_date DESC LIMIT 500`;
			params = [orgId];
		} else {
			query = `SELECT ${cols} FROM ${USER_ARTICLES_TABLE} WHERE user_id = $1 AND organization_id IS NULL ${dateFilter} ORDER BY scraped_date DESC LIMIT 500`;
			params = [args.userId];
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

		return { articles };
	} finally {
		await db.end();
	}
}
