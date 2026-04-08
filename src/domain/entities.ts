import type { Client } from 'pg';
import { logError, logInfo } from '../infra/log';

interface ExtractedEntity {
	name: string;
	name_cn: string;
	type: string;
}

/**
 * Sync extracted entities from an article to the normalized entities + article_entities tables.
 * Upserts entities by canonical_name (lowercased English name) and links them to the article.
 */
export async function syncArticleEntities(db: Client, articleId: string, entities: ExtractedEntity[]): Promise<void> {
	if (!entities.length) return;

	for (const entity of entities) {
		const canonical = entity.name.toLowerCase().trim();
		if (!canonical) continue;

		try {
			// Upsert entity by canonical name
			const result = await db.query(
				`INSERT INTO entities (canonical_name, name, name_cn, type)
				 VALUES ($1, $2, $3, $4)
				 ON CONFLICT (canonical_name) DO UPDATE SET
				   updated_at = NOW()
				 RETURNING id`,
				[canonical, entity.name, entity.name_cn, entity.type],
			);
			const entityId = result.rows[0]?.id;
			if (!entityId) continue;

			// Link article to entity
			await db.query(`INSERT INTO article_entities (article_id, entity_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [articleId, entityId]);
		} catch (err) {
			logError('ENTITIES', 'Failed to sync entity', { entity: entity.name, error: String(err) });
		}
	}

	// Batch update article counts for all entities linked to this article
	await db.query(
		`UPDATE entities SET article_count = (
		   SELECT COUNT(*) FROM article_entities WHERE entity_id = entities.id
		 ) WHERE id IN (
		   SELECT entity_id FROM article_entities WHERE article_id = $1
		 )`,
		[articleId],
	);

	logInfo('ENTITIES', 'Synced', { articleId, count: entities.length });
}
