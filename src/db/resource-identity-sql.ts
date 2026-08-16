import {
	RESOURCE_KIND_DISPLAY_LABELS,
	RESOURCE_PLATFORM_DISPLAY_LABELS,
	type ResourceIdentityFilters,
	type ResourcePlatform,
	TRANSLATABLE_RESOURCE_KINDS,
} from '@core-shared/resource-types';
import { type SQL, sql } from 'drizzle-orm';
import { textArraySql } from './client';

type ResourceIdentitySqlFields = {
	kind: SQL;
	resourcePlatform: SQL;
};

export function contentResourceIdentitySql(fields: ResourceIdentitySqlFields): SQL {
	return sql`(
		(${fields.kind} = 'blog' AND ${fields.resourcePlatform} IS NULL)
		OR (${fields.kind} = 'forum' AND ${fields.resourcePlatform} = 'hackernews')
		OR (${fields.kind} = 'post' AND ${fields.resourcePlatform} = 'twitter')
		OR (${fields.kind} = 'video' AND ${fields.resourcePlatform} = 'youtube')
		OR (${fields.kind} = 'paper' AND (${fields.resourcePlatform} IS NULL OR ${fields.resourcePlatform} = 'hackernews'))
	)`;
}

export function translatableResourceIdentitySql(fields: ResourceIdentitySqlFields & { fileType: SQL }): SQL {
	return sql`(
		${fields.kind} = ANY(${textArraySql(TRANSLATABLE_RESOURCE_KINDS)})
		AND (
			${fields.fileType} IS DISTINCT FROM 'application/pdf'
			OR ${fields.resourcePlatform} IS NOT NULL
		)
	)`;
}

function resourceKindFilterSql(field: SQL, kinds: ResourceIdentityFilters['kinds']): SQL {
	return kinds === undefined ? sql`TRUE` : sql`${field} = ANY(${textArraySql(kinds)})`;
}

function resourcePlatformFilterSql(field: SQL, resourcePlatforms: ResourceIdentityFilters['resourcePlatforms']): SQL {
	if (resourcePlatforms === undefined) return sql`TRUE`;
	const includesNull = resourcePlatforms.includes(null);
	const nonNullPlatforms = resourcePlatforms.filter((platform): platform is Exclude<ResourcePlatform, null> => platform !== null);
	if (includesNull && nonNullPlatforms.length > 0) {
		return sql`(${field} IS NULL OR ${field} = ANY(${textArraySql(nonNullPlatforms)}))`;
	}
	if (includesNull) return sql`${field} IS NULL`;
	if (nonNullPlatforms.length > 0) return sql`${field} = ANY(${textArraySql(nonNullPlatforms)})`;
	return sql`FALSE`;
}

export function resourceIdentityFilterSql(fields: ResourceIdentitySqlFields, filters: ResourceIdentityFilters): SQL {
	if (filters.kinds === undefined && filters.resourcePlatforms === undefined) return sql`TRUE`;
	return sql`(
		${resourceKindFilterSql(fields.kind, filters.kinds)}
		AND ${resourcePlatformFilterSql(fields.resourcePlatform, filters.resourcePlatforms)}
	)`;
}

export function resourceDisplaySourceSql(
	fields: ResourceIdentitySqlFields & {
		monitoredSourceName: SQL;
		platformMetadata: SQL;
	},
): SQL {
	return sql`COALESCE(
		NULLIF(BTRIM(${fields.monitoredSourceName}), ''),
		NULLIF(BTRIM(${fields.platformMetadata}->>'sourceName'), ''),
		CASE ${fields.resourcePlatform}
			WHEN 'twitter' THEN ${RESOURCE_PLATFORM_DISPLAY_LABELS.twitter}
			WHEN 'youtube' THEN ${RESOURCE_PLATFORM_DISPLAY_LABELS.youtube}
			WHEN 'hackernews' THEN ${RESOURCE_PLATFORM_DISPLAY_LABELS.hackernews}
		END,
		CASE ${fields.kind}
			WHEN 'blog' THEN ${RESOURCE_KIND_DISPLAY_LABELS.blog}
			WHEN 'forum' THEN ${RESOURCE_KIND_DISPLAY_LABELS.forum}
			WHEN 'post' THEN ${RESOURCE_KIND_DISPLAY_LABELS.post}
			WHEN 'video' THEN ${RESOURCE_KIND_DISPLAY_LABELS.video}
			WHEN 'paper' THEN ${RESOURCE_KIND_DISPLAY_LABELS.paper}
			WHEN 'image' THEN ${RESOURCE_KIND_DISPLAY_LABELS.image}
			WHEN 'file' THEN ${RESOURCE_KIND_DISPLAY_LABELS.file}
		END
	)`;
}
