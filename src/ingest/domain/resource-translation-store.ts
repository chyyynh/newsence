import type { ResourceTranslationSource } from '@core-shared/resource-types';
import type { CoreDb } from '@db/client';
import { textArraySql } from '@db/sql';
import { sql } from 'drizzle-orm';

type ResourceTranslationWrite = {
	resourceId: string;
	lang: string;
	title?: string | null;
	summary?: string | null;
	content?: string | null;
	keywords?: string[];
	source: ResourceTranslationSource;
	expectedOriginalTranslationHash?: string;
};

/**
 * Row ownership is human > original > machine. Within the winning owner,
 * explicitly supplied fields replace current values; omitted fields are patches.
 */
export async function upsertResourceTranslation(db: CoreDb, input: ResourceTranslationWrite): Promise<boolean> {
	const keywords = textArraySql(input.keywords ?? []);
	const result = await db.execute(sql`
		WITH target_resource AS (
			SELECT resource.id
			FROM resources resource
			WHERE resource.id = ${input.resourceId}::uuid
			  AND (${input.source} <> 'original' OR resource.original_lang = ${input.lang})
			  AND (
					${input.expectedOriginalTranslationHash ?? null}::text IS NULL
				OR EXISTS (
					SELECT 1
					FROM resource_translations original
					WHERE original.resource_id = resource.id
					  AND original.lang = resource.original_lang
					  AND md5(jsonb_build_array(original.title, original.summary, original.content)::text) = ${input.expectedOriginalTranslationHash ?? null}
					FOR SHARE
				)
			  )
		), demoted_originals AS (
			UPDATE resource_translations translation
			SET source = 'machine', updated_at = NOW()
			FROM target_resource
			WHERE ${input.source} = 'original'
			  AND translation.resource_id = target_resource.id
			  AND translation.lang <> ${input.lang}
			  AND translation.source = 'original'
			RETURNING translation.resource_id
		)
		INSERT INTO resource_translations AS current_translation (
			resource_id, lang, title, summary, content, keywords, source
		)
		SELECT
			target_resource.id,
			${input.lang},
			${input.title ?? null},
			${input.summary ?? null},
			${input.content ?? null},
			${keywords},
			${input.source}
		FROM target_resource
		ON CONFLICT (resource_id, lang) DO UPDATE SET
			title = CASE
				WHEN current_translation.source = 'human' AND excluded.source <> 'human' THEN current_translation.title
				WHEN current_translation.source = 'original' AND excluded.source = 'machine' THEN current_translation.title
				WHEN ${input.title === undefined} THEN current_translation.title
				ELSE excluded.title
			END,
			summary = CASE
				WHEN current_translation.source = 'human' AND excluded.source <> 'human' THEN current_translation.summary
				WHEN current_translation.source = 'original' AND excluded.source = 'machine' THEN current_translation.summary
				WHEN ${input.summary === undefined} THEN current_translation.summary
				ELSE excluded.summary
			END,
			content = CASE
				WHEN current_translation.source = 'human' AND excluded.source <> 'human' THEN current_translation.content
				WHEN current_translation.source = 'original' AND excluded.source = 'machine' THEN current_translation.content
				WHEN ${input.content === undefined} THEN current_translation.content
				ELSE excluded.content
			END,
			keywords = CASE
				WHEN current_translation.source = 'human' AND excluded.source <> 'human' THEN current_translation.keywords
				WHEN current_translation.source = 'original' AND excluded.source = 'machine' THEN current_translation.keywords
				WHEN ${input.keywords === undefined} THEN current_translation.keywords
				ELSE excluded.keywords
			END,
			source = CASE
				WHEN current_translation.source = 'human' AND excluded.source <> 'human' THEN current_translation.source
				WHEN current_translation.source = 'original' AND excluded.source = 'machine' THEN current_translation.source
				ELSE excluded.source
			END,
			updated_at = NOW()
		RETURNING resource_id::text AS resource_id
	`);
	return result.rows.length > 0;
}
