// Mirrors frontend/src/lib/ai/tools/search-news.ts. Hybrid retrieval when
// the query has text; date-ordered catalog when it doesn't.

import { withClient } from '@shared/db/client';
import type { Env } from '@shared/types';
import { tool } from 'ai';
import { z } from 'zod';
import { ARTICLE_COLS_SUMMARY, searchArticles, sortByRank } from '../search/articles';

const SEARCH_LIMIT = 200;
const RESULT_LIMIT = 10;
const SUMMARY_MAX = 500;

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

interface ArticleSummary {
	id: string;
	title: string;
	url: string;
	publishedDate?: string;
	source?: string | null;
	summary?: string;
	tags?: string[] | null;
}

export type SearchNewsResult = { results: ArticleSummary[] };

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

export function createSearchNewsTool(env: Env) {
	return tool({
		description:
			'Search the news database. Hybrid search over titles, summaries, and embeddings — ' +
			'pass natural-language queries, exact phrases, or tickers; the search handles all of them. ' +
			'Returns article summaries; use read-context with article IDs to get full text. ' +
			'If results are empty or unhelpful, retry with a broader daysAgo (or omit it) ' +
			'or rephrase the query — do not assume the topic does not exist.',
		inputSchema: z.object({
			query: z.string().describe('Search query — natural language or keywords'),
			daysAgo: z.number().min(1).max(365).optional().describe('Only search articles from the last N days'),
		}),
		execute: async ({ query, daysAgo }): Promise<SearchNewsResult> => {
			const articles = await withClient(env, async (client) => {
				const trimmed = query.trim();
				const ranks = trimmed ? await searchArticles(client, env, trimmed, SEARCH_LIMIT) : null;
				const fromDate = daysAgo ? new Date(Date.now() - daysAgo * 86_400_000) : null;

				if (ranks) {
					if (ranks.size === 0) return [];
					// `searchArticles` already over-fetched 5× and recency-decayed; trust
					// its top-N and re-rank only what we actually return.
					const candidateIds = [...ranks.keys()].slice(0, RESULT_LIMIT);
					const params: unknown[] = [candidateIds];
					let where = `id = ANY($1::uuid[])`;
					if (fromDate) {
						params.push(fromDate);
						where += ` AND published_date >= $${params.length}`;
					}
					const result = await client.query<ArticleRow>(`SELECT ${ARTICLE_COLS_SUMMARY} FROM articles WHERE ${where}`, params);
					return sortByRank(result.rows, ranks);
				}

				const params: unknown[] = [];
				let where = 'TRUE';
				if (fromDate) {
					params.push(fromDate);
					where = `published_date >= $${params.length}`;
				}
				params.push(RESULT_LIMIT);
				const result = await client.query<ArticleRow>(
					`SELECT ${ARTICLE_COLS_SUMMARY} FROM articles WHERE ${where} ORDER BY published_date DESC LIMIT $${params.length}`,
					params,
				);
				return result.rows;
			});
			return { results: articles.map(formatArticle) };
		},
	});
}
