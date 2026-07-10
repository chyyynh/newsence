import type { CoreDb } from '@db/client';
import { textArraySql } from '@db/sql';
import { sql } from 'drizzle-orm';
import type { ResourceTranslationSource } from '../../resources/types';

export type ResourceTranslationWrite = {
	resourceId: string;
	lang: string;
	title?: string | null;
	summary?: string | null;
	content?: string | null;
	keywords?: string[];
	source: ResourceTranslationSource;
	expectedSourceContentHash?: string;
};

/**
 * Row ownership is human > original > machine. Within the winning owner,
 * incoming non-empty fields replace current values and empty fields are patches.
 */
export async function upsertResourceTranslation(db: CoreDb, input: ResourceTranslationWrite): Promise<boolean> {
	const expectedSourceContentHash = input.expectedSourceContentHash ?? null;
	const keywords = textArraySql(input.keywords ?? []);
	const result = await db.execute(sql`
		WITH target_resource AS (
			SELECT resource.id
			FROM resources resource
			LEFT JOIN resource_localization_state localization
			  ON localization.resource_id = resource.id
			WHERE resource.id = ${input.resourceId}::uuid
			  AND (${input.source} <> 'original' OR resource.original_lang = ${input.lang})
			  AND (
				${expectedSourceContentHash}::text IS NULL
				OR localization.current_source_content_hash = ${expectedSourceContentHash}
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
				ELSE COALESCE(NULLIF(excluded.title, ''), current_translation.title)
			END,
			summary = CASE
				WHEN current_translation.source = 'human' AND excluded.source <> 'human' THEN current_translation.summary
				WHEN current_translation.source = 'original' AND excluded.source = 'machine' THEN current_translation.summary
				ELSE COALESCE(NULLIF(excluded.summary, ''), current_translation.summary)
			END,
			content = CASE
				WHEN current_translation.source = 'human' AND excluded.source <> 'human' THEN current_translation.content
				WHEN current_translation.source = 'original' AND excluded.source = 'machine' THEN current_translation.content
				ELSE COALESCE(NULLIF(excluded.content, ''), current_translation.content)
			END,
			keywords = CASE
				WHEN current_translation.source = 'human' AND excluded.source <> 'human' THEN current_translation.keywords
				WHEN current_translation.source = 'original' AND excluded.source = 'machine' THEN current_translation.keywords
				WHEN cardinality(excluded.keywords) > 0 THEN excluded.keywords
				ELSE current_translation.keywords
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
