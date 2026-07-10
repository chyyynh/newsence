import { withCoreDb } from '@db/client';
import { sql } from 'drizzle-orm';
import { upsertResourceTranslation } from './resource-translation-store';

// `currentSourceContentHash` versions the canonical original; `sourceContentHash`
// advances only after every localization write for that version succeeds.
const MAX_LOCALIZATION_ATTEMPTS = 3;
const RESOURCE_REQUIRES_LOCALIZATION = sql`
	r.enrichment_status = 'enriched'
	AND r.scope = 'corpus'
	AND r.type IN ('rss', 'hackernews', 'web', 'twitter')
	AND r.url IS NOT NULL
	AND r.original_lang <> 'zh-Hant'
`;

export type ContentLocalizationClaim = {
	resourceId: string;
	sourceContentHash: string;
	attempt: number;
};

export class ContentLocalizationSourceChangedError extends Error {
	constructor(resourceId: string) {
		super(`Resource ${resourceId} original content changed during localization`);
		this.name = 'ContentLocalizationSourceChangedError';
	}
}

export async function getPersistedResourceContentHashForLocalization(env: CoreEnv, resourceId: string): Promise<string | null> {
	return withCoreDb(env, async (db) => {
		const result = await db.execute(sql`
			SELECT r.platform_metadata #>> '{contentLocalization,currentSourceContentHash}' AS source_content_hash
			FROM resources r
			WHERE r.id = ${resourceId}::uuid
			  AND ${RESOURCE_REQUIRES_LOCALIZATION}
			  AND r.platform_metadata #>> '{contentLocalization,currentSourceContentHash}' IS NOT NULL
			LIMIT 1
		`);
		return (result.rows as Array<{ source_content_hash: string }>)[0]?.source_content_hash ?? null;
	});
}

export async function claimContentLocalizationBackfill(env: CoreEnv, limit = 10): Promise<ContentLocalizationClaim[]> {
	return withCoreDb(env, async (db) => {
		const result = await db.execute(sql`
			WITH candidates AS (
				SELECT
					r.id,
					r.platform_metadata #>> '{contentLocalization,currentSourceContentHash}' AS source_content_hash,
					CASE
						WHEN r.platform_metadata #>> '{contentLocalization,attemptContentHash}' IS DISTINCT FROM
							r.platform_metadata #>> '{contentLocalization,currentSourceContentHash}'
							THEN 1
						ELSE COALESCE((r.platform_metadata #>> '{contentLocalization,attempts}')::integer, 0) + 1
					END AS attempt
				FROM resources r
				WHERE ${RESOURCE_REQUIRES_LOCALIZATION}
				  AND r.platform_metadata #>> '{contentLocalization,currentSourceContentHash}' IS NOT NULL
				  AND r.platform_metadata #>> '{contentLocalization,sourceContentHash}' IS DISTINCT FROM
					r.platform_metadata #>> '{contentLocalization,currentSourceContentHash}'
				  AND (
					r.platform_metadata #>> '{contentLocalization,attemptContentHash}' IS DISTINCT FROM
						r.platform_metadata #>> '{contentLocalization,currentSourceContentHash}'
					OR COALESCE((r.platform_metadata #>> '{contentLocalization,attempts}')::integer, 0) < ${MAX_LOCALIZATION_ATTEMPTS}
				  )
				  AND (
					r.platform_metadata #>> '{contentLocalization,attemptContentHash}' IS DISTINCT FROM
						r.platform_metadata #>> '{contentLocalization,currentSourceContentHash}'
					OR r.platform_metadata #>> '{contentLocalization,lastAttemptAt}' IS NULL
					OR (r.platform_metadata #>> '{contentLocalization,lastAttemptAt}')::timestamptz < NOW() - CASE
						WHEN COALESCE((r.platform_metadata #>> '{contentLocalization,attempts}')::integer, 0) <= 1
							THEN INTERVAL '15 minutes'
						ELSE INTERVAL '1 hour'
					END
				  )
				ORDER BY r.id
				LIMIT ${Math.max(1, Math.min(Math.trunc(limit), 50))}
				FOR UPDATE OF r SKIP LOCKED
			)
			UPDATE resources resource
			SET platform_metadata = jsonb_set(
					COALESCE(resource.platform_metadata, '{}'::jsonb),
					'{contentLocalization}',
					COALESCE(resource.platform_metadata->'contentLocalization', '{}'::jsonb)
						|| jsonb_build_object(
							'status', 'queued',
							'attemptContentHash', candidates.source_content_hash,
							'attempts', candidates.attempt,
							'lastAttemptAt', NOW(),
							'completedAt', NULL,
							'error', NULL
						),
				true
			)
			FROM candidates
			WHERE resource.id = candidates.id
			RETURNING resource.id::text AS resource_id, candidates.source_content_hash, candidates.attempt
		`);
		return (result.rows as Array<{ resource_id: string; source_content_hash: string; attempt: number }>).map((row) => ({
			resourceId: row.resource_id,
			sourceContentHash: row.source_content_hash,
			attempt: row.attempt,
		}));
	});
}

async function markContentLocalization(
	env: CoreEnv,
	resourceId: string,
	sourceContentHash: string,
	status: 'complete' | 'failed' | 'running',
	error?: string,
	exhausted = false,
): Promise<boolean> {
	const patch = JSON.stringify({
		status,
		attemptContentHash: sourceContentHash,
		...(status === 'complete' ? { sourceContentHash } : {}),
		completedAt: status === 'complete' ? new Date().toISOString() : null,
		...(exhausted ? { attempts: MAX_LOCALIZATION_ATTEMPTS } : {}),
		...(error ? { error: error.slice(0, 500) } : { error: null }),
	});
	return withCoreDb(env, async (db) => {
		const result = await db.execute(sql`
			UPDATE resources resource
			SET platform_metadata = jsonb_set(
				COALESCE(resource.platform_metadata, '{}'::jsonb),
				'{contentLocalization}',
				COALESCE(resource.platform_metadata->'contentLocalization', '{}'::jsonb) || ${patch}::jsonb,
				true
			)
			WHERE resource.id = ${resourceId}::uuid
			  AND resource.platform_metadata #>> '{contentLocalization,currentSourceContentHash}' = ${sourceContentHash}
			RETURNING resource.id::text AS id
		`);
		return result.rows.length > 0;
	});
}

async function markCurrentContentLocalization(
	env: CoreEnv,
	resourceId: string,
	sourceContentHash: string,
	status: 'complete' | 'running',
): Promise<void> {
	if (!(await markContentLocalization(env, resourceId, sourceContentHash, status))) {
		throw new ContentLocalizationSourceChangedError(resourceId);
	}
}

export function markContentLocalizationRunning(env: CoreEnv, resourceId: string, sourceContentHash: string): Promise<void> {
	return markCurrentContentLocalization(env, resourceId, sourceContentHash, 'running');
}

export function markContentLocalizationComplete(env: CoreEnv, resourceId: string, sourceContentHash: string): Promise<void> {
	return markCurrentContentLocalization(env, resourceId, sourceContentHash, 'complete');
}

export async function markContentLocalizationFailed(
	env: CoreEnv,
	resourceId: string,
	sourceContentHash: string,
	error: unknown,
): Promise<void> {
	await markContentLocalization(env, resourceId, sourceContentHash, 'failed', String(error));
}

export async function exhaustContentLocalizationAttempts(
	env: CoreEnv,
	resourceId: string,
	sourceContentHash: string,
	error: unknown,
): Promise<void> {
	await markContentLocalization(env, resourceId, sourceContentHash, 'failed', String(error), true);
}

export type MachineTranslationPatch = {
	title?: string;
	summary?: string;
	content?: string;
};

export async function persistMachineZhHantTranslation(
	env: CoreEnv,
	resourceId: string,
	sourceContentHash: string,
	patch: MachineTranslationPatch,
): Promise<void> {
	const persisted = await withCoreDb(env, (db) =>
		upsertResourceTranslation(db, {
			resourceId,
			lang: 'zh-Hant',
			...patch,
			keywords: [],
			source: 'machine',
			expectedSourceContentHash: sourceContentHash,
		}),
	);
	if (!persisted) throw new ContentLocalizationSourceChangedError(resourceId);
}

export function persistBackfilledZhHantContent(
	env: CoreEnv,
	resourceId: string,
	sourceContentHash: string,
	content: string,
): Promise<void> {
	return persistMachineZhHantTranslation(env, resourceId, sourceContentHash, { content });
}

export async function clearMachineZhHantContent(env: CoreEnv, resourceId: string, sourceContentHash: string): Promise<void> {
	await withCoreDb(env, async (db) => {
		await db.execute(sql`
			UPDATE resource_translations translation
			SET content = NULL, updated_at = NOW()
			FROM resources resource
			WHERE translation.resource_id = ${resourceId}::uuid
			  AND translation.lang = 'zh-Hant'
			  AND translation.source = 'machine'
			  AND resource.id = translation.resource_id
			  AND resource.platform_metadata #>> '{contentLocalization,currentSourceContentHash}' = ${sourceContentHash}
		`);
	});
}
