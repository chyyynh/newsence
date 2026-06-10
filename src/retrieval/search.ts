// Hybrid pgvector + keyword search with RRF + recency decay. Moved here from the
// chat worker (which mirrored frontend/src/lib/search/index.ts) so the corpus +
// embeddings + Hyperdrive all live in one place; the chat worker calls
// `searchArticles` via the CORE service binding. SQL kept verbatim so worker chat
// and the UI search bar return the same ranking.

import { generateArticleEmbedding } from '@shared/embedding';
import type { Env } from '@shared/types';
import type { Client } from 'pg';

export type SearchResponse = Map<string, number>;

// Shared SELECT projections for the `articles` table. Summary is what search
// returns to the model; Full adds body content for read-context.
export const ARTICLE_COLS_SUMMARY = 'id, title, title_cn, url, published_date, source, summary, summary_cn, tags';
export const ARTICLE_COLS_FULL = `${ARTICLE_COLS_SUMMARY}, content, content_cn, source_type`;

const EMPTY: SearchResponse = new Map();
const RRF_K = 60;
const RECENCY_HALF_LIFE_DAYS = 30;
const OVERFETCH_MULTIPLIER = 5;
const OVERFETCH_CAP = 200;

export function sortByRank<T extends { id: string }>(articles: T[], ranks: SearchResponse): T[] {
	return [...articles].sort((a, b) => (ranks.get(b.id) ?? 0) - (ranks.get(a.id) ?? 0));
}

export async function searchArticles(client: Client, env: Env, query: string, limit = 100): Promise<SearchResponse> {
	const sanitized = sanitize(query);
	if (!sanitized) return EMPTY;

	const tokens = tokenize(sanitized);
	const patterns = tokens.length > 0 ? tokens.map((t) => `%${t}%`) : [`%${sanitized}%`];

	const embedding = await generateArticleEmbedding(sanitized, env.AI).catch(() => null);
	if (!embedding) return keywordOnly(client, patterns, limit);
	const vectorStr = `[${embedding.join(',')}]`;

	try {
		const result = await client.query<{ id: string; score: number | string }>(
			`
			WITH vec AS (
				SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rank
				FROM articles
				WHERE embedding IS NOT NULL
				ORDER BY embedding <=> $1::vector
				LIMIT $2
			),
			kw AS (
				SELECT id, ROW_NUMBER() OVER (ORDER BY published_date DESC NULLS LAST) AS rank
				FROM articles
				WHERE EXISTS (SELECT 1 FROM unnest(keywords) k WHERE k ILIKE ANY($3::text[]))
				   OR title ILIKE ANY($3::text[])
				   OR title_cn ILIKE ANY($3::text[])
				LIMIT $2
			),
			fused AS (
				SELECT id, 1.0 / ($4 + rank) AS score FROM vec
				UNION ALL
				SELECT id, 1.0 / ($4 + rank) AS score FROM kw
			),
			scored AS (
				SELECT id, SUM(score) AS s FROM fused GROUP BY id
			)
			SELECT
				s.id::text,
				s.s * (1.0 / (1 + EXTRACT(EPOCH FROM now() - a.published_date) / 86400.0 / $5)) AS score
			FROM scored s
			JOIN articles a ON s.id = a.id
			ORDER BY score DESC
			LIMIT $6
			`,
			[vectorStr, Math.min(limit * OVERFETCH_MULTIPLIER, OVERFETCH_CAP), patterns, RRF_K, RECENCY_HALF_LIFE_DAYS, limit],
		);
		return new Map(result.rows.map((r) => [r.id, Number(r.score)]));
	} catch (e) {
		console.warn('[searchArticles] hybrid query failed:', e);
		return keywordOnly(client, patterns, limit);
	}
}

async function keywordOnly(client: Client, patterns: string[], limit: number): Promise<SearchResponse> {
	try {
		const result = await client.query<{ id: string; match_count: number | string }>(
			`
			SELECT id,
				(SELECT COUNT(*) FROM unnest(keywords) k WHERE k ILIKE ANY($1::text[])) AS match_count
			FROM articles
			WHERE EXISTS (SELECT 1 FROM unnest(keywords) k WHERE k ILIKE ANY($1::text[]))
			   OR title ILIKE ANY($1::text[])
			   OR title_cn ILIKE ANY($1::text[])
			ORDER BY match_count DESC, published_date DESC NULLS LAST
			LIMIT $2
			`,
			[patterns, limit],
		);
		const max = Math.max(...result.rows.map((r) => Number(r.match_count)), 1);
		return new Map(result.rows.map((r) => [r.id, Number(r.match_count) / max]));
	} catch (e) {
		console.warn('[searchArticles] keyword fallback failed:', e);
		return EMPTY;
	}
}

function sanitize(query: string, maxLength = 200): string {
	return query
		.trim()
		.replace(/['"\\;!&|():<>]/g, ' ')
		.replace(/\s+/g, ' ')
		.slice(0, maxLength);
}

function tokenize(sanitized: string): string[] {
	const parts = sanitized.split(/[\s,，、。.;；!！?？/\\|]+/).filter(Boolean);
	const tokens = new Set<string>();
	for (const p of parts) {
		if (/[㐀-鿿぀-ヿ]/.test(p) || p.length >= 2) {
			tokens.add(p);
		}
	}
	return [...tokens].slice(0, 8);
}
