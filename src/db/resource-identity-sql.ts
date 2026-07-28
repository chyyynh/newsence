import {
	CONTENT_RESOURCE_KINDS,
	CONTENT_RESOURCE_TYPES,
	legacyResourceIdentity,
	legacyResourceIdentityFilterCases,
	RESOURCE_KIND_DISPLAY_LABELS,
	RESOURCE_ORIGINAL_CONTENT_TYPES,
	RESOURCE_PLATFORM_DISPLAY_LABELS,
	type ResourceIdentityFilters,
	type ResourcePlatform,
	resourceIdentityDisplayLabel,
	TRANSLATABLE_RESOURCE_KINDS,
} from '@core-shared/resource-types';
import { type SQL, sql } from 'drizzle-orm';
import { textArraySql } from './client';

export type ResourceIdentitySqlFields = {
	kind: SQL;
	resourcePlatform: SQL;
	type: SQL;
};

// `IS TRUE` collapses rollout NULLs to false. Callers negate these predicates
// in completeness checks, where SQL's three-valued NOT NULL would otherwise
// preserve NULL and accidentally require content from legacy PDF/YouTube rows.
export function contentResourceIdentitySql(fields: ResourceIdentitySqlFields): SQL {
	return sql`((
		${fields.kind} = ANY(${textArraySql(CONTENT_RESOURCE_KINDS)})
		OR (
			${fields.kind} IS NULL
			AND ${fields.resourcePlatform} IS NULL
			AND ${fields.type} = ANY(${textArraySql(CONTENT_RESOURCE_TYPES)})
		)
	)) IS TRUE`;
}

export function translatableResourceIdentitySql(fields: ResourceIdentitySqlFields & { fileType: SQL }): SQL {
	return sql`((
		(
			${fields.kind} = ANY(${textArraySql(TRANSLATABLE_RESOURCE_KINDS)})
			AND (
				${fields.fileType} IS DISTINCT FROM 'application/pdf'
				OR ${fields.resourcePlatform} IS NOT NULL
			)
		)
		OR (
			${fields.kind} IS NULL
			AND ${fields.resourcePlatform} IS NULL
			AND ${fields.type} = ANY(${textArraySql(RESOURCE_ORIGINAL_CONTENT_TYPES)})
		)
	)) IS TRUE`;
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

function semanticScholarAcademicEnrichmentSql(platformMetadata: SQL): SQL {
	return sql`COALESCE(
		jsonb_typeof(${platformMetadata} #> '{enrichments,academic}') = 'object'
		AND ${platformMetadata} #>> '{enrichments,academic,source}' = 'semanticscholar',
		FALSE
	)`;
}

export function resourceIdentityFilterSql(
	fields: ResourceIdentitySqlFields & { platformMetadata: SQL },
	filters: ResourceIdentityFilters,
): SQL {
	if (filters.kinds === undefined && filters.resourcePlatforms === undefined) return sql`TRUE`;

	const legacyCases = legacyResourceIdentityFilterCases(filters);
	const academicIrrelevantTypes = legacyCases.filter((entry) => entry.academic === 'irrelevant').map((entry) => entry.type);
	const academicRequiredTypes = legacyCases.filter((entry) => entry.academic === true).map((entry) => entry.type);
	const academicExcludedTypes = legacyCases.filter((entry) => entry.academic === false).map((entry) => entry.type);
	const hasAcademicEnrichment = semanticScholarAcademicEnrichmentSql(fields.platformMetadata);

	return sql`(
		(
			${fields.kind} IS NOT NULL
			AND ${resourceKindFilterSql(fields.kind, filters.kinds)}
			AND ${resourcePlatformFilterSql(fields.resourcePlatform, filters.resourcePlatforms)}
		)
		OR (
			${fields.kind} IS NULL
			AND ${fields.resourcePlatform} IS NULL
			AND (
				${fields.type} = ANY(${textArraySql(academicIrrelevantTypes)})
				OR (
					${fields.type} = ANY(${textArraySql(academicRequiredTypes)})
					AND ${hasAcademicEnrichment}
				)
				OR (
					${fields.type} = ANY(${textArraySql(academicExcludedTypes)})
					AND NOT (${hasAcademicEnrichment})
				)
			)
		)
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
			WHEN 'document' THEN ${RESOURCE_KIND_DISPLAY_LABELS.document}
			WHEN 'post' THEN ${RESOURCE_KIND_DISPLAY_LABELS.post}
			WHEN 'video' THEN ${RESOURCE_KIND_DISPLAY_LABELS.video}
			WHEN 'paper' THEN ${RESOURCE_KIND_DISPLAY_LABELS.paper}
			WHEN 'image' THEN ${RESOURCE_KIND_DISPLAY_LABELS.image}
			WHEN 'file' THEN ${RESOURCE_KIND_DISPLAY_LABELS.file}
		END,
		CASE ${fields.type}
			WHEN 'twitter' THEN ${resourceIdentityDisplayLabel(legacyResourceIdentity('twitter'))}
			WHEN 'youtube' THEN ${resourceIdentityDisplayLabel(legacyResourceIdentity('youtube'))}
			WHEN 'hackernews' THEN ${resourceIdentityDisplayLabel(legacyResourceIdentity('hackernews'))}
			WHEN 'image' THEN ${resourceIdentityDisplayLabel(legacyResourceIdentity('image'))}
			WHEN 'file' THEN ${resourceIdentityDisplayLabel(legacyResourceIdentity('file'))}
			ELSE ${resourceIdentityDisplayLabel(legacyResourceIdentity('web'))}
		END
	)`;
}
