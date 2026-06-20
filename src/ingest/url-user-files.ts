import { USER_FILES_TABLE } from '@shared/article-store';
import type { DbClient } from '@shared/db';
import { normalizeUrl } from '@shared/web';

export interface InsertUrlUserFileData {
	url: string;
	title: string;
	source: string;
	publishedDate: Date | string;
	summary: string;
	platformType: 'web' | 'youtube' | 'twitter' | 'hackernews';
	content: string | null;
	ogImageUrl: string | null;
	platformMetadata: unknown | null;
	userId: string;
	normalizedUrl?: string;
	keywords?: string[];
	tags?: string[];
}

export type InsertUrlUserFileResult = {
	id: string;
	created: boolean;
	title: string;
	title_cn: string | null;
	summary_cn: string | null;
	tags: string[];
	platform_type: string | null;
	og_image_url: string | null;
};

export type ExistingUrlUserFile = {
	id: string;
	title: string;
	title_cn: string | null;
	summary_cn: string | null;
	tags: string[] | null;
	platform_type: string | null;
	og_image_url: string | null;
	resource_kind: string;
	has_embedding: boolean;
};

const EXISTING_URL_USER_FILE_FIELDS =
	'id, title, title_cn, summary_cn, tags, platform_type, og_image_url, resource_kind, embedding IS NOT NULL AS has_embedding';

function serializeMetadata(metadata: unknown | null): string | null {
	if (metadata === null || metadata === undefined) return null;
	return JSON.stringify(metadata);
}

/**
 * Insert scraped URL content into the per-user `user_files` table.
 *
 * The DB owns URL identity through the partial unique index on
 * (user_id, normalized_source_url) for resource_kind='url'. Callers may dedup
 * for efficiency, but correctness comes from this conflict-safe insert.
 */
export async function insertUrlUserFile(db: DbClient, data: InsertUrlUserFileData): Promise<InsertUrlUserFileResult | null> {
	const normalizedUrl = data.normalizedUrl ?? normalizeUrl(data.url);
	const result = await db.query(
		`WITH inserted AS (
			INSERT INTO ${USER_FILES_TABLE}
			(file_name, file_type, resource_kind, origin_type, platform_type, source_url, normalized_source_url, title, site_name, published_date,
			 summary, extracted_text, og_image_url, keywords, tags, metadata,
			 user_id)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
			ON CONFLICT (user_id, normalized_source_url)
			WHERE resource_kind = 'url' AND normalized_source_url IS NOT NULL
			DO NOTHING
			RETURNING id, title, title_cn, summary_cn, tags, platform_type, og_image_url, TRUE AS created
		)
		SELECT id, title, title_cn, summary_cn, tags, platform_type, og_image_url, created FROM inserted
		UNION ALL
		SELECT id, title, title_cn, summary_cn, tags, platform_type, og_image_url, FALSE AS created
		FROM ${USER_FILES_TABLE}
		WHERE user_id = $17
		  AND normalized_source_url = $7
		  AND resource_kind = 'url'
		  AND NOT EXISTS (SELECT 1 FROM inserted)
		LIMIT 1`,
		[
			data.title,
			data.platformType,
			'url',
			'saved_url',
			data.platformType,
			data.url,
			normalizedUrl,
			data.title,
			data.source,
			data.publishedDate,
			data.summary,
			data.content,
			data.ogImageUrl,
			data.keywords ?? [],
			data.tags ?? [],
			serializeMetadata(data.platformMetadata),
			data.userId,
		],
	);
	const row = result.rows[0] as InsertUrlUserFileResult | undefined;
	return row ?? null;
}

export async function getUrlUserFileByNormalizedSourceUrl(
	db: DbClient,
	userId: string,
	normalizedUrl: string,
): Promise<ExistingUrlUserFile | null> {
	const existing = await db.query<ExistingUrlUserFile>(
		`SELECT ${EXISTING_URL_USER_FILE_FIELDS} FROM ${USER_FILES_TABLE}
		 WHERE user_id = $1
		   AND normalized_source_url = $2
		 LIMIT 1`,
		[userId, normalizedUrl],
	);
	return existing.rows[0] ?? null;
}
