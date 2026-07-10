import { withCoreDb } from '@db/client';
import { resourceTranslations } from '@db/schema';
import { sql } from 'drizzle-orm';

const MAX_LOCALIZATION_ATTEMPTS = 3;
const PARTIAL_TRANSLATION_RATIO = 0.2;

export type ContentLocalizationClaim = {
	resourceId: string;
	attempt: number;
};

export async function claimContentLocalizationBackfill(env: CoreEnv, limit = 10): Promise<ContentLocalizationClaim[]> {
	return withCoreDb(env, async (db) => {
		const result = await db.execute(sql`
			WITH candidates AS (
				SELECT
					r.id,
					COALESCE((r.platform_metadata #>> '{contentLocalization,attempts}')::integer, 0) + 1 AS attempt
				FROM resources r
				JOIN resource_translations original
				  ON original.resource_id = r.id
				 AND original.lang = r.original_lang
				LEFT JOIN resource_translations zh_hant
				  ON zh_hant.resource_id = r.id
				 AND zh_hant.lang = 'zh-Hant'
				WHERE r.enrichment_status = 'enriched'
				  AND r.scope = 'corpus'
				  AND r.type IN ('rss', 'hackernews', 'web', 'twitter')
				  AND r.url IS NOT NULL
				  AND (
					NULLIF(BTRIM(original.content), '') IS NULL
					OR original.content ILIKE '%data:image/%'
					OR (
						r.original_lang <> 'zh-Hant'
						AND zh_hant.source IS DISTINCT FROM 'human'
						AND (
							NULLIF(BTRIM(zh_hant.content), '') IS NULL
							OR zh_hant.content ILIKE '%data:image/%'
							OR (
								zh_hant.source = 'machine'
								AND NULLIF(BTRIM(regexp_replace(original.content, 'https?://[^[:space:]]+', '', 'gi')), '') IS NULL
								AND NULLIF(BTRIM(zh_hant.content), '') IS NOT NULL
							)
							OR length(zh_hant.content)::numeric / GREATEST(length(original.content), 1) < ${PARTIAL_TRANSLATION_RATIO}
						)
					)
				  )
				  AND COALESCE((r.platform_metadata #>> '{contentLocalization,attempts}')::integer, 0) < ${MAX_LOCALIZATION_ATTEMPTS}
				  AND (
					r.platform_metadata #>> '{contentLocalization,lastAttemptAt}' IS NULL
					OR (r.platform_metadata #>> '{contentLocalization,lastAttemptAt}')::timestamptz < NOW() - CASE
						WHEN COALESCE((r.platform_metadata #>> '{contentLocalization,attempts}')::integer, 0) <= 1
							THEN INTERVAL '15 minutes'
						ELSE INTERVAL '1 hour'
					END
				  )
				ORDER BY
					EXISTS (SELECT 1 FROM library item WHERE item.resource_id = r.id) DESC,
					COALESCE(r.published_date, r.created_at) DESC,
					r.id DESC
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
						'attempts', candidates.attempt,
						'lastAttemptAt', NOW(),
						'error', NULL
					),
				true
			)
			FROM candidates
			WHERE resource.id = candidates.id
			RETURNING resource.id::text AS resource_id, candidates.attempt
		`);
		return (result.rows as Array<{ resource_id: string; attempt: number }>).map((row) => ({
			resourceId: row.resource_id,
			attempt: row.attempt,
		}));
	});
}

async function markContentLocalization(
	env: CoreEnv,
	resourceId: string,
	status: 'complete' | 'failed' | 'running',
	error?: string,
	exhausted = false,
): Promise<void> {
	const patch = JSON.stringify({
		status,
		completedAt: status === 'complete' ? new Date().toISOString() : null,
		...(exhausted ? { attempts: MAX_LOCALIZATION_ATTEMPTS } : {}),
		...(error ? { error: error.slice(0, 500) } : { error: null }),
	});
	await withCoreDb(env, async (db) => {
		await db.execute(sql`
			UPDATE resources
			SET platform_metadata = jsonb_set(
				COALESCE(platform_metadata, '{}'::jsonb),
				'{contentLocalization}',
				COALESCE(platform_metadata->'contentLocalization', '{}'::jsonb) || ${patch}::jsonb,
				true
			)
			WHERE id = ${resourceId}::uuid
		`);
	});
}

export function markContentLocalizationRunning(env: CoreEnv, resourceId: string): Promise<void> {
	return markContentLocalization(env, resourceId, 'running');
}

export function markContentLocalizationComplete(env: CoreEnv, resourceId: string): Promise<void> {
	return markContentLocalization(env, resourceId, 'complete');
}

export function markContentLocalizationFailed(env: CoreEnv, resourceId: string, error: unknown): Promise<void> {
	return markContentLocalization(env, resourceId, 'failed', String(error));
}

export function exhaustContentLocalizationAttempts(env: CoreEnv, resourceId: string, error: unknown): Promise<void> {
	return markContentLocalization(env, resourceId, 'failed', String(error), true);
}

export async function persistRecoveredOriginalContent(env: CoreEnv, resourceId: string, lang: string, content: string): Promise<void> {
	await withCoreDb(env, async (db) => {
		await db.execute(sql`
			UPDATE resource_translations
			SET content = ${content}, updated_at = NOW()
			WHERE resource_id = ${resourceId}::uuid
			  AND lang = ${lang}
			  AND source <> 'human'
			  AND (NULLIF(BTRIM(content), '') IS NULL OR content ILIKE '%data:image/%')
		`);
	});
}

export type MachineTranslationPatch = {
	title?: string;
	summary?: string;
	content?: string;
};

export async function persistMachineZhHantTranslation(env: CoreEnv, resourceId: string, patch: MachineTranslationPatch): Promise<void> {
	await withCoreDb(env, async (db) => {
		await db
			.insert(resourceTranslations)
			.values({
				resourceId,
				lang: 'zh-Hant',
				title: patch.title,
				summary: patch.summary,
				content: patch.content,
				keywords: [],
				source: 'machine',
			})
			.onConflictDoUpdate({
				target: [resourceTranslations.resourceId, resourceTranslations.lang],
				set: {
					title: sql`CASE
						WHEN ${resourceTranslations.source} = 'human' THEN ${resourceTranslations.title}
						ELSE COALESCE(NULLIF(${resourceTranslations.title}, ''), excluded.title)
					END`,
					summary: sql`CASE
						WHEN ${resourceTranslations.source} = 'human' THEN ${resourceTranslations.summary}
						ELSE COALESCE(NULLIF(${resourceTranslations.summary}, ''), excluded.summary)
					END`,
					content: sql`CASE
						WHEN ${resourceTranslations.source} = 'human' THEN ${resourceTranslations.content}
						ELSE COALESCE(NULLIF(excluded.content, ''), ${resourceTranslations.content})
					END`,
					source: sql`CASE
						WHEN ${resourceTranslations.source} = 'human' THEN ${resourceTranslations.source}
						ELSE 'machine'
					END`,
					updatedAt: sql`NOW()`,
				},
			});
	});
}

export function persistBackfilledZhHantContent(env: CoreEnv, resourceId: string, content: string): Promise<void> {
	return persistMachineZhHantTranslation(env, resourceId, { content });
}

export async function clearMachineZhHantContent(env: CoreEnv, resourceId: string): Promise<void> {
	await withCoreDb(env, async (db) => {
		await db.execute(sql`
			UPDATE resource_translations
			SET content = NULL, updated_at = NOW()
			WHERE resource_id = ${resourceId}::uuid
			  AND lang = 'zh-Hant'
			  AND source = 'machine'
		`);
	});
}
