import { NonRetryableError } from 'cloudflare:workflows';
import { type CoreDb, withCoreDb } from '@db/client';
import { textArraySql } from '@db/sql';
import { sql } from 'drizzle-orm';
import { RESOURCE_ORIGINAL_CONTENT_TYPES } from '../../resources/types';
import { upsertResourceTranslation } from './resource-translation-store';

const MAX_LOCALIZATION_ATTEMPTS = 3;

export type ContentLocalizationClaim = {
	resourceId: string;
	sourceContentHash: string;
	attempt: number;
};

export class ContentLocalizationSourceChangedError extends NonRetryableError {
	constructor(resourceId: string) {
		super(`Resource ${resourceId} original content changed during localization`, 'ContentLocalizationSourceChangedError');
	}
}

export async function getPersistedResourceContentHashForLocalization(env: CoreEnv, resourceId: string): Promise<string | null> {
	return withCoreDb(env, async (db) => {
		const result = await db.execute(sql`
			SELECT current_source_content_hash AS source_content_hash
			FROM resource_localization_state
			WHERE resource_id = ${resourceId}::uuid
			  AND current_source_content_hash IS NOT NULL
			  AND source_content_hash IS DISTINCT FROM current_source_content_hash
			LIMIT 1
		`);
		return (result.rows as Array<{ source_content_hash: string }>)[0]?.source_content_hash ?? null;
	});
}

/** Single writer for resource_localization_state rows derived from the persisted original translation. */
export async function syncResourceContentLocalizationState(
	db: CoreDb,
	resourceId: string,
	sourceContentOverride?: string | null,
): Promise<void> {
	const sourceContentSql = sourceContentOverride === undefined ? sql`original.content` : sql`${sourceContentOverride}::text`;
	await db.execute(sql`
		WITH source AS (
			SELECT
				resource.id,
				(
					resource.scope = 'corpus'
					AND resource.type = ANY(${textArraySql(RESOURCE_ORIGINAL_CONTENT_TYPES)})
					AND resource.url IS NOT NULL
					AND resource.original_lang <> 'zh-Hant'
				) AS requires_localization,
				(
					NULLIF(BTRIM(original.title), '') IS NOT NULL
					AND NULLIF(BTRIM(${sourceContentSql}), '') IS NOT NULL
				) AS has_usable_content,
				CASE
					WHEN resource.scope = 'corpus'
					 AND resource.type = ANY(${textArraySql(RESOURCE_ORIGINAL_CONTENT_TYPES)})
					 AND resource.url IS NOT NULL
					 AND resource.original_lang <> 'zh-Hant'
					 AND NULLIF(BTRIM(original.title), '') IS NOT NULL
					 AND NULLIF(BTRIM(${sourceContentSql}), '') IS NOT NULL
						THEN md5(${sourceContentSql})
					ELSE NULL
				END AS current_source_content_hash
			FROM resources resource
			JOIN resource_translations original
			  ON original.resource_id = resource.id
			 AND original.lang = resource.original_lang
			WHERE resource.id = ${resourceId}::uuid
		)
		INSERT INTO resource_localization_state AS state (
			resource_id,
			status,
			current_source_content_hash,
			attempts,
			created_at,
			updated_at
		)
		SELECT
			source.id,
			CASE
				WHEN NOT source.requires_localization THEN 'not_required'
				WHEN NOT source.has_usable_content THEN 'blocked_on_content'
				ELSE 'pending'
			END,
			source.current_source_content_hash,
			0,
			NOW(),
			NOW()
		FROM source
		ON CONFLICT (resource_id) DO UPDATE SET
			status = CASE
				WHEN excluded.status IN ('not_required', 'blocked_on_content') THEN excluded.status
				WHEN state.source_content_hash = excluded.current_source_content_hash THEN 'complete'
				WHEN state.current_source_content_hash IS NOT DISTINCT FROM excluded.current_source_content_hash THEN state.status
				ELSE 'pending'
			END,
			current_source_content_hash = excluded.current_source_content_hash,
			attempt_content_hash = CASE
				WHEN excluded.status IN ('not_required', 'blocked_on_content')
				  OR state.current_source_content_hash IS DISTINCT FROM excluded.current_source_content_hash THEN NULL
				ELSE state.attempt_content_hash
			END,
			attempts = CASE
				WHEN excluded.status IN ('not_required', 'blocked_on_content')
				  OR state.current_source_content_hash IS DISTINCT FROM excluded.current_source_content_hash THEN 0
				ELSE state.attempts
			END,
			last_attempt_at = CASE
				WHEN excluded.status IN ('not_required', 'blocked_on_content')
				  OR state.current_source_content_hash IS DISTINCT FROM excluded.current_source_content_hash THEN NULL
				ELSE state.last_attempt_at
			END,
			completed_at = CASE
				WHEN state.source_content_hash = excluded.current_source_content_hash THEN state.completed_at
				ELSE NULL
			END,
			error = CASE
				WHEN excluded.status IN ('not_required', 'blocked_on_content')
				  OR state.current_source_content_hash IS DISTINCT FROM excluded.current_source_content_hash THEN NULL
				ELSE state.error
			END,
			updated_at = NOW()
	`);
}

export async function claimContentLocalizationWork(env: CoreEnv, limit = 10): Promise<ContentLocalizationClaim[]> {
	return withCoreDb(env, async (db) => {
		const result = await db.execute(sql`
			WITH candidates AS (
				SELECT
					state.resource_id,
					state.current_source_content_hash AS source_content_hash,
					CASE
						WHEN state.attempt_content_hash IS DISTINCT FROM state.current_source_content_hash THEN 1
						ELSE state.attempts + 1
					END AS attempt
				FROM resource_localization_state state
				WHERE state.current_source_content_hash IS NOT NULL
				  AND state.source_content_hash IS DISTINCT FROM state.current_source_content_hash
				  AND (
					state.attempt_content_hash IS DISTINCT FROM state.current_source_content_hash
					OR state.attempts < ${MAX_LOCALIZATION_ATTEMPTS}
				  )
				  AND (
					state.attempt_content_hash IS DISTINCT FROM state.current_source_content_hash
					OR state.last_attempt_at IS NULL
					OR state.last_attempt_at < NOW() - CASE
						WHEN state.attempts <= 1 THEN INTERVAL '15 minutes'
						ELSE INTERVAL '1 hour'
					END
				  )
				ORDER BY state.resource_id
				LIMIT ${Math.max(1, Math.min(Math.trunc(limit), 50))}
				FOR UPDATE OF state SKIP LOCKED
			)
			UPDATE resource_localization_state state
			SET status = 'queued',
				attempt_content_hash = candidates.source_content_hash,
				attempts = candidates.attempt,
				last_attempt_at = NOW(),
				completed_at = NULL,
				error = NULL,
				updated_at = NOW()
			FROM candidates
			WHERE state.resource_id = candidates.resource_id
			RETURNING state.resource_id::text AS resource_id, candidates.source_content_hash, candidates.attempt
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
	return withCoreDb(env, async (db) => {
		const result = await db.execute(sql`
			UPDATE resource_localization_state state
			SET status = ${status},
				attempt_content_hash = ${sourceContentHash},
				source_content_hash = CASE
					WHEN ${status} = 'complete' THEN ${sourceContentHash}
					ELSE state.source_content_hash
				END,
				completed_at = CASE WHEN ${status} = 'complete' THEN NOW() ELSE NULL END,
				attempts = CASE
					WHEN ${exhausted} THEN ${MAX_LOCALIZATION_ATTEMPTS}
					WHEN ${status} IN ('running', 'failed') THEN GREATEST(state.attempts, 1)
					ELSE state.attempts
				END,
				last_attempt_at = CASE
					WHEN ${status} IN ('running', 'failed') THEN NOW()
					ELSE state.last_attempt_at
				END,
				error = ${error ? error.slice(0, 500) : null},
				updated_at = NOW()
			WHERE state.resource_id = ${resourceId}::uuid
			  AND state.current_source_content_hash = ${sourceContentHash}
			RETURNING state.resource_id::text AS id
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
	const isCurrent = await withCoreDb(env, async (db) => {
		const result = await db.execute(sql`
			WITH current_state AS (
				SELECT resource_id
				FROM resource_localization_state
				WHERE resource_id = ${resourceId}::uuid
				  AND current_source_content_hash = ${sourceContentHash}
			), updated AS (
				UPDATE resource_translations translation
				SET content = NULL, updated_at = NOW()
				FROM current_state
				WHERE translation.resource_id = current_state.resource_id
				  AND translation.lang = 'zh-Hant'
				  AND translation.source = 'machine'
				RETURNING translation.resource_id
			)
			SELECT EXISTS (SELECT 1 FROM current_state) AS is_current
		`);
		return (result.rows as Array<{ is_current: boolean }>)[0]?.is_current ?? false;
	});
	if (!isCurrent) throw new ContentLocalizationSourceChangedError(resourceId);
}
