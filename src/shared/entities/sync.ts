// ─────────────────────────────────────────────────────────────
// Entity sync: reconcile the entities / article_entities tables
// with an article's normalized entity list.
// ─────────────────────────────────────────────────────────────

import type { DbClient } from '../db';
import { type ArticleEntityInput, canonicalizeEntityName, normalizeArticleEntitiesForStorage } from './normalize';

export async function syncArticleEntities(
	db: DbClient,
	articleId: string,
	entities: ArticleEntityInput[],
	source?: string | null,
	platformMetadata?: unknown,
): Promise<void> {
	const normalizedEntities = normalizeArticleEntitiesForStorage(entities, source, platformMetadata);
	const entityIds: string[] = [];
	const existingLinks = await db.query<{ entity_id: string }>(`SELECT entity_id FROM article_entities WHERE article_id = $1`, [articleId]);

	for (const entity of normalizedEntities) {
		const canonical = canonicalizeEntityName(entity.name);
		if (!canonical) continue;

		const result = await db.query(
			`INSERT INTO entities (canonical_name, name, name_cn, type)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (canonical_name) DO UPDATE SET
			   name = EXCLUDED.name,
			   name_cn = EXCLUDED.name_cn,
			   type = EXCLUDED.type,
			   updated_at = NOW()
			 RETURNING id`,
			[canonical, entity.name, entity.name_cn, entity.type],
		);
		const entityId = result.rows[0]?.id;
		if (!entityId) throw new Error(`Failed to sync entity ${canonical}: no entity id returned`);
		entityIds.push(entityId);
	}

	if (entityIds.length) {
		await db.query(`DELETE FROM article_entities WHERE article_id = $1 AND NOT (entity_id = ANY($2::uuid[]))`, [articleId, entityIds]);
	} else {
		await db.query(`DELETE FROM article_entities WHERE article_id = $1`, [articleId]);
	}

	for (const entityId of entityIds) {
		await db.query(`INSERT INTO article_entities (article_id, entity_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [articleId, entityId]);
	}

	await refreshEntityArticleCounts(db, [...existingLinks.rows.map((row) => row.entity_id), ...entityIds]);

	console.info({
		tag: 'ENTITIES',
		msg: 'Synced',
		articleId,
		inputCount: entities.length,
		count: normalizedEntities.length,
		filteredCount: entities.length - normalizedEntities.length,
	});
}

/** Recompute article_count from actual links; reconciles drift the insert/delete triggers can miss. */
async function refreshEntityArticleCounts(db: DbClient, entityIds: string[]): Promise<void> {
	const uniqueIds = [...new Set(entityIds)];
	if (!uniqueIds.length) return;
	await db.query(
		`UPDATE entities e
		    SET article_count = counts.article_count
		   FROM (
		     SELECT ids.id, COUNT(ae.article_id)::int AS article_count
		       FROM unnest($1::uuid[]) AS ids(id)
		       LEFT JOIN article_entities ae ON ae.entity_id = ids.id
		      GROUP BY ids.id
		   ) counts
		  WHERE e.id = counts.id`,
		[uniqueIds],
	);
}
