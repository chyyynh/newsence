import { withCoreDb } from '@db/client';
import { textArraySql } from '@db/sql';
import { sql } from 'drizzle-orm';
import { RESOURCE_ORIGINAL_CONTENT_TYPES } from '../../resources/types';
import { upsertResourceTranslation } from './resource-translation-store';

export async function getPersistedResourceContentHashForLocalization(env: CoreEnv, resourceId: string): Promise<string | null> {
	return withCoreDb(env, async (db) => {
		const result = await db.execute(sql`
			SELECT md5(original.content) AS source_content_hash
			FROM resources resource
			JOIN resource_translations original
			  ON original.resource_id = resource.id
			 AND original.lang = resource.original_lang
			WHERE resource.id = ${resourceId}::uuid
			  AND resource.scope = 'corpus'
			  AND resource.type = ANY(${textArraySql(RESOURCE_ORIGINAL_CONTENT_TYPES)})
			  AND resource.url IS NOT NULL
			  AND resource.original_lang <> 'zh-Hant'
			  AND NULLIF(BTRIM(original.title), '') IS NOT NULL
			  AND NULLIF(BTRIM(original.content), '') IS NOT NULL
			LIMIT 1
		`);
		return (result.rows as Array<{ source_content_hash: string }>)[0]?.source_content_hash ?? null;
	});
}

export type MachineTranslationPatch = {
	title?: string;
	summary?: string;
	content?: string;
};

export async function persistMachineZhHantTranslation(env: CoreEnv, resourceId: string, patch: MachineTranslationPatch): Promise<void> {
	const persisted = await withCoreDb(env, (db) =>
		upsertResourceTranslation(db, {
			resourceId,
			lang: 'zh-Hant',
			...patch,
			keywords: [],
			source: 'machine',
		}),
	);
	if (!persisted) throw new Error(`Failed to persist machine translation for resource ${resourceId}`);
}

export function persistMachineZhHantContent(env: CoreEnv, resourceId: string, content: string): Promise<void> {
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
