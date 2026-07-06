// ─────────────────────────────────────────────────────────────
// Entity maintenance: batch repair / backfill selection / pruning.
// Driven by the internal /entities/* HTTP endpoints.
// ─────────────────────────────────────────────────────────────

import { ARTICLES_TABLE } from '@core-shared/article-store';
import type { DbClient } from '@core-shared/db';
import { isArticleEntityInput, normalizeArticleEntitiesForStorage } from './normalize';
import { syncArticleEntities } from './sync';

export type MaintenanceCursor = { id: string; publishedDate: string };

type ArticleEntityRepairRow = {
	id: string;
	source: string | null;
	platform_metadata: unknown;
	entities: unknown;
	published_date: string | Date | null;
};

export async function repairMissingArticleEntityLinks(
	db: DbClient,
	limit: number,
	options: { before?: Date | string; cursor?: MaintenanceCursor; includeLinked?: boolean; sourceType?: string } = {},
): Promise<{
	scanned: number;
	repaired: number;
	normalized: number;
	skipped: number;
	nextBefore: string | null;
	nextCursor: MaintenanceCursor | null;
}> {
	const cursorDate = options.cursor?.publishedDate ?? options.before ?? null;
	const cursorId = options.cursor?.id ?? null;
	const result = await db.query<ArticleEntityRepairRow>(
		`SELECT a.id, a.source, a.platform_metadata, a.entities, a.published_date
		   FROM ${ARTICLES_TABLE} a
		  WHERE jsonb_typeof(a.entities) = 'array'
		    AND jsonb_array_length(a.entities) > 0
		    AND (
		      $2::timestamptz IS NULL
		      OR a.published_date < $2
		      OR ($3::uuid IS NOT NULL AND a.published_date = $2 AND a.id > $3::uuid)
		    )
		    AND ($4::boolean OR NOT EXISTS (
		      SELECT 1 FROM article_entities ae WHERE ae.article_id = a.id
		    ))
		    AND (
		      $5::text IS NULL
		      OR COALESCE(NULLIF(TRIM(a.source_type), ''), 'unknown') = $5
		    )
		  ORDER BY a.published_date DESC, a.id ASC
		  LIMIT $1`,
		[limit, cursorDate, cursorId, options.includeLinked === true, options.sourceType ?? null],
	);

	let repaired = 0;
	let normalized = 0;
	let skipped = 0;
	const last = result.rows.length === limit ? result.rows.at(-1) : undefined;
	const nextBefore = last?.published_date ? new Date(last.published_date).toISOString() : null;
	const nextCursor = nextBefore && last ? { id: last.id, publishedDate: nextBefore } : null;

	for (const row of result.rows) {
		if (!Array.isArray(row.entities)) {
			skipped++;
			continue;
		}

		const rawEntities = row.entities.filter(isArticleEntityInput);
		const entities = normalizeArticleEntitiesForStorage(rawEntities, row.source, row.platform_metadata);
		const normalizedJson = JSON.stringify(entities);
		if (!entities.length) {
			await db.query(`UPDATE ${ARTICLES_TABLE} SET entities = '[]'::jsonb WHERE id = $1`, [row.id]);
			skipped++;
			continue;
		}

		if (normalizedJson !== JSON.stringify(row.entities)) {
			await db.query(`UPDATE ${ARTICLES_TABLE} SET entities = $2::jsonb WHERE id = $1`, [row.id, normalizedJson]);
			normalized++;
		}
		await syncArticleEntities(db, row.id, entities, row.source, row.platform_metadata);
		repaired++;
	}

	return {
		scanned: result.rows.length,
		repaired,
		normalized,
		skipped,
		nextBefore,
		nextCursor,
	};
}

export type MissingEntityArticle = { id: string; publishedDate: string | null };

export async function getArticlesMissingEntities(
	db: DbClient,
	limit: number,
	options: { before?: Date | string; cursor?: MaintenanceCursor; includeEmpty?: boolean; sourceType?: string } = {},
): Promise<MissingEntityArticle[]> {
	const cursorDate = options.cursor?.publishedDate ?? options.before ?? null;
	const cursorId = options.cursor?.id ?? null;
	const result = await db.query<{ id: string; published_date: string | Date | null }>(
		`SELECT id, published_date FROM ${ARTICLES_TABLE}
		  WHERE (
		      $2::timestamptz IS NULL
		      OR published_date < $2
		      OR ($3::uuid IS NOT NULL AND published_date = $2 AND id > $3::uuid)
		    )
		    AND (
		      entities IS NULL
		      OR jsonb_typeof(entities) <> 'array'
		      OR (
		        $4::boolean
		        AND CASE
		          WHEN jsonb_typeof(entities) = 'array' THEN jsonb_array_length(entities) = 0
		          ELSE false
		        END
		      )
		    )
		    AND (
		      content IS NOT NULL
		      OR summary IS NOT NULL
		    )
		    AND (
		      $5::text IS NULL
		      OR COALESCE(NULLIF(TRIM(source_type), ''), 'unknown') = $5
		    )
		  ORDER BY published_date DESC, id ASC
		  LIMIT $1`,
		[limit, cursorDate, cursorId, options.includeEmpty === true, options.sourceType ?? null],
	);
	return result.rows.map((row) => ({
		id: row.id,
		publishedDate: row.published_date ? new Date(row.published_date).toISOString() : null,
	}));
}

export async function pruneOrphanEntities(db: DbClient, limit: number): Promise<{ deleted: number }> {
	const result = await db.query<{ deleted: number }>(
		`WITH orphan_entities AS (
		   SELECT e.id
		     FROM entities e
		    WHERE NOT EXISTS (
		      SELECT 1 FROM article_entities ae WHERE ae.entity_id = e.id
		    )
		    ORDER BY e.updated_at ASC
		    LIMIT $1
		 ),
		 deleted_entities AS (
		   DELETE FROM entities e
		    USING orphan_entities o
		    WHERE e.id = o.id
		    RETURNING e.id
		 )
		 SELECT COUNT(*)::int AS deleted FROM deleted_entities`,
		[limit],
	);
	return { deleted: result.rows[0]?.deleted ?? 0 };
}
