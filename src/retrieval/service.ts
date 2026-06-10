// Chat-retrieval facade — the only module the chat worker reaches (via the CORE
// service binding RPC). Owns the Hyperdrive connection lifecycle for a single
// retrieval call; the corpus SQL + embedding live in ./search and ./read-context.

import { createDbClient } from '@shared/db/articles';
import type { Env } from '@shared/types';
import { type ReadContextItem, type ReadContextResult, readContextItems as readItems } from './read-context';
import { ARTICLE_COLS_SUMMARY, searchArticles as rankArticles, sortByRank } from './search';

export type { ReadContextItem, ReadContextResult } from './read-context';

const SEARCH_LIMIT = 200;
const RESULT_LIMIT = 10;
const SUMMARY_MAX = 500;

export interface ArticleSummary {
	id: string;
	title: string;
	url: string;
	publishedDate?: string;
	source?: string | null;
	summary?: string;
	tags?: string[] | null;
}

interface ArticleRow {
	id: string;
	title: string;
	title_cn: string | null;
	url: string;
	published_date: Date | string | null;
	source: string | null;
	summary: string | null;
	summary_cn: string | null;
	tags: string[] | null;
}

function toIsoString(value: Date | string | null): string | undefined {
	if (value === null) return undefined;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function formatArticle(a: ArticleRow): ArticleSummary {
	const summary = a.summary_cn ?? a.summary ?? undefined;
	return {
		id: a.id,
		title: a.title_cn || a.title,
		url: a.url,
		publishedDate: toIsoString(a.published_date),
		source: a.source ?? undefined,
		summary: summary ? summary.slice(0, SUMMARY_MAX) : undefined,
		tags: a.tags ?? undefined,
	};
}

/**
 * Hybrid retrieval when the query has text; date-ordered catalog when it
 * doesn't. Mirrors the old chat-worker search-news tool's behaviour, now behind
 * the CORE service binding.
 */
export async function searchArticles(env: Env, query: string, opts?: { daysAgo?: number; limit?: number }): Promise<ArticleSummary[]> {
	const limit = opts?.limit ?? RESULT_LIMIT;
	const client = await createDbClient(env);
	try {
		const trimmed = query.trim();
		const ranks = trimmed ? await rankArticles(client, env, trimmed, SEARCH_LIMIT) : null;
		const fromDate = opts?.daysAgo ? new Date(Date.now() - opts.daysAgo * 86_400_000) : null;

		if (ranks) {
			if (ranks.size === 0) return [];
			// `rankArticles` already over-fetched 5× and recency-decayed; trust its
			// top-N and re-rank only what we actually return.
			const candidateIds = [...ranks.keys()].slice(0, limit);
			const params: unknown[] = [candidateIds];
			let where = `id = ANY($1::uuid[])`;
			if (fromDate) {
				params.push(fromDate);
				where += ` AND published_date >= $${params.length}`;
			}
			const result = await client.query<ArticleRow>(`SELECT ${ARTICLE_COLS_SUMMARY} FROM articles WHERE ${where}`, params);
			return sortByRank(result.rows, ranks).map(formatArticle);
		}

		const params: unknown[] = [];
		let where = 'TRUE';
		if (fromDate) {
			params.push(fromDate);
			where = `published_date >= $${params.length}`;
		}
		params.push(limit);
		const result = await client.query<ArticleRow>(
			`SELECT ${ARTICLE_COLS_SUMMARY} FROM articles WHERE ${where} ORDER BY published_date DESC LIMIT $${params.length}`,
			params,
		);
		return result.rows.map(formatArticle);
	} finally {
		await client.end();
	}
}

/** Read article/collection/url items — one result per input item, in order. */
export async function readContextItems(env: Env, items: ReadContextItem[], userId: string): Promise<ReadContextResult[]> {
	const client = await createDbClient(env);
	try {
		return await readItems(client, items, userId);
	} finally {
		await client.end();
	}
}
