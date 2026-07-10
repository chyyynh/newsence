import { withCoreDb } from '@db/client';
import { resources } from '@db/schema';
import { textArraySql } from '@db/sql';
import { eq, sql } from 'drizzle-orm';
import { RESOURCE_ENRICHMENT_TYPES, RESOURCE_ORIGINAL_CONTENT_TYPES } from '../../resources/types';

export async function markResourceEnrichmentFailed(env: CoreEnv, resourceId: string): Promise<void> {
	await withCoreDb(env, async (db) => {
		const updated = await db
			.update(resources)
			.set({ enrichmentStatus: 'failed', updatedAt: sql`NOW()` })
			.where(eq(resources.id, resourceId))
			.returning({ id: resources.id });
		if (!updated.length) throw new Error(`Failed to mark resource ${resourceId} as failed: not found`);
	});
}

export async function claimResourcesForEnrichmentRecovery(env: CoreEnv, limit = 50): Promise<string[]> {
	return withCoreDb(env, async (db) => {
		const result = await db.execute(sql`
			WITH candidates AS (
				SELECT id
				FROM resources
				WHERE type = ANY(${textArraySql(RESOURCE_ENRICHMENT_TYPES)})
				  AND (
					enrichment_status = 'pending' AND updated_at < NOW() - INTERVAL '15 minutes'
					OR (
						enrichment_status = 'failed'
						AND updated_at < NOW() - INTERVAL '30 minutes'
						AND NOT (
							scope = 'corpus'
							AND type = ANY(${textArraySql(RESOURCE_ORIGINAL_CONTENT_TYPES)})
							AND url IS NOT NULL
							AND EXISTS (
								SELECT 1
								FROM resource_translations original
								WHERE original.resource_id = resources.id
								  AND original.lang = resources.original_lang
								  AND NULLIF(BTRIM(original.content), '') IS NULL
							)
						)
					)
				  )
				ORDER BY updated_at ASC
				LIMIT ${Math.max(1, Math.min(Math.trunc(limit), 100))}
				FOR UPDATE SKIP LOCKED
			)
			UPDATE resources resource
			SET enrichment_status = 'pending', updated_at = NOW()
			FROM candidates
			WHERE resource.id = candidates.id
			RETURNING resource.id::text AS id
		`);
		return (result.rows as Array<{ id: string }>).map((row) => row.id);
	});
}
