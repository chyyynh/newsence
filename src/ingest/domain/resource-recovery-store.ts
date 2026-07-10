import { withCoreDb } from '@db/client';
import { resources } from '@db/schema';
import { textArraySql } from '@db/sql';
import { eq, type SQL, sql } from 'drizzle-orm';
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

type RecoverySweep = {
	candidateColumns: SQL;
	from: SQL;
	where: SQL;
	orderBy: SQL;
	limit: number;
	maxLimit: number;
	lockTarget?: SQL;
	extraSet?: SQL;
};

// Shared sweep skeleton: lock candidates with FOR UPDATE SKIP LOCKED, then stamp them pending in the same statement.
async function claimRecoverySweep(env: CoreEnv, sweep: RecoverySweep): Promise<string[]> {
	return withCoreDb(env, async (db) => {
		const result = await db.execute(sql`
			WITH candidates AS (
				SELECT ${sweep.candidateColumns}
				FROM ${sweep.from}
				WHERE ${sweep.where}
				ORDER BY ${sweep.orderBy}
				LIMIT ${Math.max(1, Math.min(Math.trunc(sweep.limit), sweep.maxLimit))}
				FOR UPDATE ${sweep.lockTarget ?? sql``} SKIP LOCKED
			)
			UPDATE resources resource
			SET enrichment_status = 'pending', updated_at = NOW()${sweep.extraSet ?? sql``}
			FROM candidates
			WHERE resource.id = candidates.id
			RETURNING resource.id::text AS id
		`);
		return (result.rows as Array<{ id: string }>).map((row) => row.id);
	});
}

export async function claimResourcesForEnrichmentRecovery(env: CoreEnv, limit = 50): Promise<string[]> {
	return claimRecoverySweep(env, {
		candidateColumns: sql`id`,
		from: sql`resources`,
		where: sql`
			type = ANY(${textArraySql(RESOURCE_ENRICHMENT_TYPES)})
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
			)`,
		orderBy: sql`updated_at ASC`,
		limit,
		maxLimit: 100,
	});
}

const MAX_ORIGINAL_CONTENT_RECOVERY_ATTEMPTS = 3;

export async function claimMissingOriginalContentRecovery(env: CoreEnv, limit = 10): Promise<string[]> {
	return claimRecoverySweep(env, {
		candidateColumns: sql`
			r.id,
			COALESCE((r.platform_metadata #>> '{contentAcquisition,attempts}')::integer, 0) + 1 AS attempt`,
		from: sql`resources r
			JOIN resource_translations original
			  ON original.resource_id = r.id
			 AND original.lang = r.original_lang`,
		where: sql`
			r.scope = 'corpus'
			AND r.type = ANY(${textArraySql(RESOURCE_ORIGINAL_CONTENT_TYPES)})
			AND r.url IS NOT NULL
			AND r.enrichment_status IN ('enriched', 'failed')
			AND (r.enrichment_status <> 'failed' OR r.updated_at < NOW() - INTERVAL '30 minutes')
			AND NULLIF(BTRIM(original.content), '') IS NULL
			AND COALESCE((r.platform_metadata #>> '{contentAcquisition,attempts}')::integer, 0) < ${MAX_ORIGINAL_CONTENT_RECOVERY_ATTEMPTS}
			AND (
				r.platform_metadata #>> '{contentAcquisition,lastAttemptAt}' IS NULL
				OR (r.platform_metadata #>> '{contentAcquisition,lastAttemptAt}')::timestamptz < NOW() - CASE
					WHEN COALESCE((r.platform_metadata #>> '{contentAcquisition,attempts}')::integer, 0) <= 1
						THEN INTERVAL '15 minutes'
					ELSE INTERVAL '1 hour'
				END
			)`,
		orderBy: sql`
			EXISTS (SELECT 1 FROM library item WHERE item.resource_id = r.id) DESC,
			COALESCE(r.published_date, r.created_at) DESC,
			r.id DESC`,
		limit,
		maxLimit: 50,
		lockTarget: sql`OF r`,
		extraSet: sql`,
			platform_metadata = jsonb_set(
				COALESCE(resource.platform_metadata, '{}'::jsonb),
				'{contentAcquisition}',
				COALESCE(resource.platform_metadata->'contentAcquisition', '{}'::jsonb)
					|| jsonb_build_object(
						'status', 'queued',
						'attempts', candidates.attempt,
						'lastAttemptAt', NOW(),
						'error', NULL
					),
				true
			)`,
	});
}
