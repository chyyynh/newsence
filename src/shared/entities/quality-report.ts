// ─────────────────────────────────────────────────────────────
// Entity quality snapshot: coverage / sync-gap / pollution
// reporting for the internal /entities/quality endpoint.
// Read-only; nothing here mutates data.
// ─────────────────────────────────────────────────────────────

import { ARTICLES_TABLE } from '../article-store';
import type { DbClient } from '../db';
import { ENTITY_TYPES } from '../types';
import { GENERIC_ENTITY_CANONICALS, MAX_ENTITIES_PER_ARTICLE } from './normalize';

const ENTITY_QUALITY_TOP_LIMIT = 10;
const ENTITY_QUALITY_EXAMPLES_PER_TYPE = 3;

type EntityQualityOverviewRow = {
	total_articles: number | string | null;
	with_entity_json: number | string | null;
	empty_entity_json: number | string | null;
	missing_entity_json: number | string | null;
	invalid_entity_json: number | string | null;
	json_without_links: number | string | null;
	max_entities_per_article: number | string | null;
	over_cap_articles: number | string | null;
	total_entities: number | string | null;
	total_entity_links: number | string | null;
	orphan_entities: number | string | null;
	article_count_drift: number | string | null;
	self_source_exact_links: number | string | null;
	generic_entity_links: number | string | null;
};
type EntityQualityCoverageCountsRow = {
	total_articles: number | string | null;
	with_entity_json: number | string | null;
	empty_entity_json: number | string | null;
	missing_or_invalid_entity_json: number | string | null;
	json_without_links: number | string | null;
};
type EntityQualityMonthlyRow = EntityQualityCoverageCountsRow & { month: string };
type EntityQualitySourceTypeRow = EntityQualityCoverageCountsRow & { source_type: string };
type EntityQualityMonthlySourceTypeRow = EntityQualityCoverageCountsRow & { month: string; source_type: string };
type EntityQualityTypeRow = { type: string; count: number | string | null; linked_article_count: number | string | null };
type EntityQualityExtensionRow = { extname: string };
type EntityQualitySelfSourceOffenderRow = {
	canonical_name: string;
	name: string;
	source: string;
	links: number | string | null;
};
type EntityQualityGenericOffenderRow = {
	canonical_name: string;
	name: string;
	links: number | string | null;
};
type EntityQualityOrphanEntityRow = {
	canonical_name: string;
	name: string;
	name_cn: string;
	type: string;
	article_count: number | string | null;
	updated_at: string | Date | null;
};
type EntityQualityTypeExampleRow = {
	type: string;
	canonical_name: string;
	name: string;
	article_count: number | string | null;
	linked_article_count: number | string | null;
};
type EntityQualitySyncGapRow = {
	id: string;
	title: string | null;
	source: string | null;
	source_type: string;
	published_date: string | Date | null;
	entity_count: number | string | null;
};
type EntityQualityArticleExampleRow = EntityQualitySyncGapRow;
type EntityQualityArticleExample = {
	id: string;
	title: string | null;
	source: string | null;
	sourceType: string;
	publishedDate: string | null;
	entityCount: number;
};
type EntityQualityBackfillRow = {
	first_entity_published_date: string | Date | null;
	processable_missing_or_empty: number | string | null;
	processable_missing_before_first_entity: number | string | null;
	oldest_processable_missing_published_date: string | Date | null;
	newest_processable_missing_published_date: string | Date | null;
};
type EntityQualityBackfillSourceTypeRow = {
	source_type: string;
	processable_missing_or_empty: number | string | null;
	processable_missing_before_first_entity: number | string | null;
	oldest_processable_missing_published_date: string | Date | null;
	newest_processable_missing_published_date: string | Date | null;
};

function intValue(value: number | string | null | undefined): number {
	return Number(value ?? 0);
}

function isoDateValue(value: string | Date | null | undefined): string | null {
	return value ? new Date(value).toISOString() : null;
}

function articleExampleValue(entry: EntityQualityArticleExampleRow): EntityQualityArticleExample {
	return {
		id: entry.id,
		title: entry.title,
		source: entry.source,
		sourceType: entry.source_type,
		publishedDate: isoDateValue(entry.published_date),
		entityCount: intValue(entry.entity_count),
	};
}

export async function getEntityQualitySnapshot(
	db: DbClient,
	options: { months: number },
): Promise<{
	overview: {
		totalArticles: number;
		withEntityJson: number;
		emptyEntityJson: number;
		missingEntityJson: number;
		invalidEntityJson: number;
		jsonWithoutLinks: number;
		maxEntitiesPerArticle: number;
		overCapArticles: number;
		totalEntities: number;
		totalEntityLinks: number;
		orphanEntities: number;
		articleCountDrift: number;
		selfSourceExactLinks: number;
		genericEntityLinks: number;
	};
	monthly: Array<{
		month: string;
		totalArticles: number;
		withEntityJson: number;
		emptyEntityJson: number;
		missingOrInvalidEntityJson: number;
		jsonWithoutLinks: number;
		coverage: number;
	}>;
	sourceTypes: Array<{
		sourceType: string;
		totalArticles: number;
		withEntityJson: number;
		emptyEntityJson: number;
		missingOrInvalidEntityJson: number;
		jsonWithoutLinks: number;
		coverage: number;
	}>;
	monthlySourceTypes: Array<{
		month: string;
		sourceType: string;
		totalArticles: number;
		withEntityJson: number;
		emptyEntityJson: number;
		missingOrInvalidEntityJson: number;
		jsonWithoutLinks: number;
		coverage: number;
	}>;
	unknownTypes: Array<{
		type: string;
		count: number;
		linkedArticleCount: number;
		examples: Array<{ canonicalName: string; name: string; articleCount: number; linkedArticleCount: number }>;
	}>;
	topOffenders: {
		selfSource: Array<{ canonicalName: string; name: string; source: string; links: number }>;
		generic: Array<{ canonicalName: string; name: string; links: number }>;
	};
	syncGaps: {
		jsonWithoutLinks: EntityQualityArticleExample[];
	};
	limitViolations: {
		overCapArticles: EntityQualityArticleExample[];
	};
	entityRows: {
		orphanEntities: Array<{
			canonicalName: string;
			name: string;
			nameCn: string;
			type: string;
			articleCount: number;
			updatedAt: string | null;
		}>;
	};
	backfill: {
		firstEntityPublishedDate: string | null;
		processableMissingOrEmpty: number;
		processableMissingBeforeFirstEntityDate: number;
		oldestProcessableMissingPublishedDate: string | null;
		newestProcessableMissingPublishedDate: string | null;
		sourceTypes: Array<{
			sourceType: string;
			processableMissingOrEmpty: number;
			processableMissingBeforeFirstEntityDate: number;
			oldestProcessableMissingPublishedDate: string | null;
			newestProcessableMissingPublishedDate: string | null;
		}>;
	};
	database: {
		extensions: {
			pgTrgm: boolean;
			vector: boolean;
		};
		missingRecommendedExtensions: string[];
	};
}> {
	const overview = await db.query<EntityQualityOverviewRow>(
		`WITH article_entity_state AS (
		   SELECT a.id,
		          CASE
		            WHEN jsonb_typeof(a.entities) = 'array' THEN jsonb_array_length(a.entities)
		            ELSE NULL
		          END AS entity_count,
		          a.entities IS NULL AS missing_entities,
		          a.entities IS NOT NULL AND jsonb_typeof(a.entities) <> 'array' AS invalid_entities
		     FROM ${ARTICLES_TABLE} a
		 ),
		 article_link_counts AS (
		   SELECT article_id, COUNT(*)::int AS link_count
		     FROM article_entities
		    GROUP BY article_id
		 ),
		 entity_link_counts AS (
		   SELECT entity_id, COUNT(*)::int AS link_count
		     FROM article_entities
		    GROUP BY entity_id
		 )
		 SELECT COUNT(*)::int AS total_articles,
		        COUNT(*) FILTER (WHERE s.entity_count > 0)::int AS with_entity_json,
		        COUNT(*) FILTER (WHERE s.entity_count = 0)::int AS empty_entity_json,
		        COUNT(*) FILTER (WHERE s.missing_entities)::int AS missing_entity_json,
		        COUNT(*) FILTER (WHERE s.invalid_entities)::int AS invalid_entity_json,
		        COUNT(*) FILTER (WHERE s.entity_count > 0 AND COALESCE(alc.link_count, 0) = 0)::int AS json_without_links,
		        COALESCE(MAX(s.entity_count), 0)::int AS max_entities_per_article,
		        COUNT(*) FILTER (WHERE s.entity_count > $1)::int AS over_cap_articles,
		        (SELECT COUNT(*)::int FROM entities) AS total_entities,
		        (SELECT COUNT(*)::int FROM article_entities) AS total_entity_links,
		        (SELECT COUNT(*)::int FROM entities e WHERE NOT EXISTS (
		          SELECT 1 FROM article_entities ae WHERE ae.entity_id = e.id
		        )) AS orphan_entities,
		        (SELECT COUNT(*)::int
		           FROM entities e
		           LEFT JOIN entity_link_counts elc ON elc.entity_id = e.id
		          WHERE e.article_count <> COALESCE(elc.link_count, 0)) AS article_count_drift,
		        (SELECT COUNT(*)::int
		           FROM article_entities ae
		           JOIN entities e ON e.id = ae.entity_id
		           JOIN ${ARTICLES_TABLE} a ON a.id = ae.article_id
		          WHERE LOWER(TRIM(a.source)) = e.canonical_name) AS self_source_exact_links,
		        (SELECT COUNT(*)::int
		           FROM article_entities ae
		           JOIN entities e ON e.id = ae.entity_id
		          WHERE e.canonical_name = ANY($2::text[])) AS generic_entity_links
		   FROM article_entity_state s
		   LEFT JOIN article_link_counts alc ON alc.article_id = s.id`,
		[MAX_ENTITIES_PER_ARTICLE, [...GENERIC_ENTITY_CANONICALS]],
	);

	const monthly = await db.query<EntityQualityMonthlyRow>(
		`WITH article_entity_state AS (
		   SELECT a.id,
		          date_trunc('month', a.published_date)::date AS month,
		          CASE
		            WHEN jsonb_typeof(a.entities) = 'array' THEN jsonb_array_length(a.entities)
		            ELSE NULL
		          END AS entity_count,
		          a.entities IS NULL OR jsonb_typeof(a.entities) <> 'array' AS missing_or_invalid_entities
		     FROM ${ARTICLES_TABLE} a
		    WHERE a.published_date >= date_trunc('month', NOW()) - ($1::int * INTERVAL '1 month')
		 ),
		 article_link_counts AS (
		   SELECT article_id, COUNT(*)::int AS link_count
		     FROM article_entities
		    GROUP BY article_id
		 )
		 SELECT to_char(s.month, 'YYYY-MM') AS month,
		        COUNT(*)::int AS total_articles,
		        COUNT(*) FILTER (WHERE s.entity_count > 0)::int AS with_entity_json,
		        COUNT(*) FILTER (WHERE s.entity_count = 0)::int AS empty_entity_json,
		        COUNT(*) FILTER (WHERE s.missing_or_invalid_entities)::int AS missing_or_invalid_entity_json,
		        COUNT(*) FILTER (WHERE s.entity_count > 0 AND COALESCE(alc.link_count, 0) = 0)::int AS json_without_links
		   FROM article_entity_state s
		   LEFT JOIN article_link_counts alc ON alc.article_id = s.id
		  GROUP BY s.month
		  ORDER BY s.month DESC`,
		[options.months],
	);

	const sourceTypes = await db.query<EntityQualitySourceTypeRow>(
		`WITH article_entity_state AS (
		   SELECT a.id,
		          COALESCE(NULLIF(TRIM(a.source_type), ''), 'unknown') AS source_type,
		          CASE
		            WHEN jsonb_typeof(a.entities) = 'array' THEN jsonb_array_length(a.entities)
		            ELSE NULL
		          END AS entity_count,
		          a.entities IS NULL OR jsonb_typeof(a.entities) <> 'array' AS missing_or_invalid_entities
		     FROM ${ARTICLES_TABLE} a
		 ),
		 article_link_counts AS (
		   SELECT article_id, COUNT(*)::int AS link_count
		     FROM article_entities
		    GROUP BY article_id
		 )
		 SELECT s.source_type,
		        COUNT(*)::int AS total_articles,
		        COUNT(*) FILTER (WHERE s.entity_count > 0)::int AS with_entity_json,
		        COUNT(*) FILTER (WHERE s.entity_count = 0)::int AS empty_entity_json,
		        COUNT(*) FILTER (WHERE s.missing_or_invalid_entities)::int AS missing_or_invalid_entity_json,
		        COUNT(*) FILTER (WHERE s.entity_count > 0 AND COALESCE(alc.link_count, 0) = 0)::int AS json_without_links
		   FROM article_entity_state s
		   LEFT JOIN article_link_counts alc ON alc.article_id = s.id
		  GROUP BY s.source_type
		  ORDER BY total_articles DESC, s.source_type ASC`,
		[],
	);

	const monthlySourceTypes = await db.query<EntityQualityMonthlySourceTypeRow>(
		`WITH article_entity_state AS (
		   SELECT a.id,
		          date_trunc('month', a.published_date)::date AS month,
		          COALESCE(NULLIF(TRIM(a.source_type), ''), 'unknown') AS source_type,
		          CASE
		            WHEN jsonb_typeof(a.entities) = 'array' THEN jsonb_array_length(a.entities)
		            ELSE NULL
		          END AS entity_count,
		          a.entities IS NULL OR jsonb_typeof(a.entities) <> 'array' AS missing_or_invalid_entities
		     FROM ${ARTICLES_TABLE} a
		    WHERE a.published_date >= date_trunc('month', NOW()) - ($1::int * INTERVAL '1 month')
		 ),
		 article_link_counts AS (
		   SELECT article_id, COUNT(*)::int AS link_count
		     FROM article_entities
		    GROUP BY article_id
		 )
		 SELECT to_char(s.month, 'YYYY-MM') AS month,
		        s.source_type,
		        COUNT(*)::int AS total_articles,
		        COUNT(*) FILTER (WHERE s.entity_count > 0)::int AS with_entity_json,
		        COUNT(*) FILTER (WHERE s.entity_count = 0)::int AS empty_entity_json,
		        COUNT(*) FILTER (WHERE s.missing_or_invalid_entities)::int AS missing_or_invalid_entity_json,
		        COUNT(*) FILTER (WHERE s.entity_count > 0 AND COALESCE(alc.link_count, 0) = 0)::int AS json_without_links
		   FROM article_entity_state s
		   LEFT JOIN article_link_counts alc ON alc.article_id = s.id
		  GROUP BY s.month, s.source_type
		  ORDER BY s.month DESC, total_articles DESC, s.source_type ASC`,
		[options.months],
	);

	const unknownTypes = await db.query<EntityQualityTypeRow>(
		`SELECT e.type,
		        COUNT(DISTINCT e.id)::int AS count,
		        COUNT(ae.article_id)::int AS linked_article_count
		   FROM entities e
		   LEFT JOIN article_entities ae ON ae.entity_id = e.id
		  WHERE NOT (e.type = ANY($1::text[]))
		  GROUP BY e.type
		  ORDER BY count DESC, type ASC`,
		[[...ENTITY_TYPES]],
	);

	const unknownTypeExamples = await db.query<EntityQualityTypeExampleRow>(
		`SELECT type,
		        canonical_name,
		        name,
		        article_count,
		        linked_article_count
		   FROM (
		     SELECT e.type,
		            e.canonical_name,
		            e.name,
		            e.article_count,
		            COUNT(ae.article_id)::int AS linked_article_count,
		            row_number() OVER (
		              PARTITION BY e.type
		              ORDER BY COUNT(ae.article_id) DESC, e.article_count DESC, e.canonical_name ASC
		            ) AS rank
		       FROM entities e
		       LEFT JOIN article_entities ae ON ae.entity_id = e.id
		      WHERE NOT (e.type = ANY($1::text[]))
		      GROUP BY e.id, e.type, e.canonical_name, e.name, e.article_count
		   ) ranked
		  WHERE rank <= $2
		  ORDER BY type ASC, rank ASC`,
		[[...ENTITY_TYPES], ENTITY_QUALITY_EXAMPLES_PER_TYPE],
	);
	const examplesByType = new Map<
		string,
		Array<{ canonicalName: string; name: string; articleCount: number; linkedArticleCount: number }>
	>();
	for (const entry of unknownTypeExamples.rows) {
		const examples = examplesByType.get(entry.type) ?? [];
		examples.push({
			canonicalName: entry.canonical_name,
			name: entry.name,
			articleCount: intValue(entry.article_count),
			linkedArticleCount: intValue(entry.linked_article_count),
		});
		examplesByType.set(entry.type, examples);
	}

	const selfSourceOffenders = await db.query<EntityQualitySelfSourceOffenderRow>(
		`SELECT e.canonical_name,
		        e.name,
		        a.source,
		        COUNT(*)::int AS links
		   FROM article_entities ae
		   JOIN entities e ON e.id = ae.entity_id
		   JOIN ${ARTICLES_TABLE} a ON a.id = ae.article_id
		  WHERE LOWER(TRIM(a.source)) = e.canonical_name
		  GROUP BY e.canonical_name, e.name, a.source
		  ORDER BY links DESC, e.canonical_name ASC
		  LIMIT $1`,
		[ENTITY_QUALITY_TOP_LIMIT],
	);

	const genericOffenders = await db.query<EntityQualityGenericOffenderRow>(
		`SELECT e.canonical_name,
		        e.name,
		        COUNT(*)::int AS links
		   FROM article_entities ae
		   JOIN entities e ON e.id = ae.entity_id
		  WHERE e.canonical_name = ANY($1::text[])
		  GROUP BY e.canonical_name, e.name
		  ORDER BY links DESC, e.canonical_name ASC
		  LIMIT $2`,
		[[...GENERIC_ENTITY_CANONICALS], ENTITY_QUALITY_TOP_LIMIT],
	);

	const jsonWithoutLinkExamples = await db.query<EntityQualitySyncGapRow>(
		`SELECT a.id,
		        a.title,
		        a.source,
		        COALESCE(NULLIF(TRIM(a.source_type), ''), 'unknown') AS source_type,
		        a.published_date,
		        jsonb_array_length(a.entities)::int AS entity_count
		   FROM ${ARTICLES_TABLE} a
		  WHERE jsonb_typeof(a.entities) = 'array'
		    AND jsonb_array_length(a.entities) > 0
		    AND NOT EXISTS (
		      SELECT 1 FROM article_entities ae WHERE ae.article_id = a.id
		    )
		  ORDER BY a.published_date DESC
		  LIMIT $1`,
		[ENTITY_QUALITY_TOP_LIMIT],
	);

	const overCapExamples = await db.query<EntityQualityArticleExampleRow>(
		`SELECT a.id,
		        a.title,
		        a.source,
		        COALESCE(NULLIF(TRIM(a.source_type), ''), 'unknown') AS source_type,
		        a.published_date,
		        jsonb_array_length(a.entities)::int AS entity_count
		   FROM ${ARTICLES_TABLE} a
		  WHERE jsonb_typeof(a.entities) = 'array'
		    AND jsonb_array_length(a.entities) > $1
		  ORDER BY entity_count DESC, a.published_date DESC
		  LIMIT $2`,
		[MAX_ENTITIES_PER_ARTICLE, ENTITY_QUALITY_TOP_LIMIT],
	);

	const orphanEntityExamples = await db.query<EntityQualityOrphanEntityRow>(
		`SELECT e.canonical_name,
		        e.name,
		        e.name_cn,
		        e.type,
		        e.article_count,
		        e.updated_at
		   FROM entities e
		  WHERE NOT EXISTS (
		    SELECT 1 FROM article_entities ae WHERE ae.entity_id = e.id
		  )
		  ORDER BY e.updated_at ASC, e.canonical_name ASC
		  LIMIT $1`,
		[ENTITY_QUALITY_TOP_LIMIT],
	);

	const backfill = await db.query<EntityQualityBackfillRow>(
		`WITH first_entity AS (
		   SELECT MIN(published_date) AS first_entity_published_date
		     FROM ${ARTICLES_TABLE}
		    WHERE jsonb_typeof(entities) = 'array'
		      AND jsonb_array_length(entities) > 0
		 ),
		 processable_backlog AS (
		   SELECT a.published_date
		     FROM ${ARTICLES_TABLE} a
		    WHERE (a.content IS NOT NULL OR a.summary IS NOT NULL)
		      AND (
		        a.entities IS NULL
		        OR jsonb_typeof(a.entities) <> 'array'
		        OR CASE
		          WHEN jsonb_typeof(a.entities) = 'array' THEN jsonb_array_length(a.entities) = 0
		          ELSE false
		        END
		      )
		 )
		 SELECT f.first_entity_published_date,
		        COUNT(p.published_date)::int AS processable_missing_or_empty,
		        COUNT(*) FILTER (
		          WHERE f.first_entity_published_date IS NOT NULL
		            AND p.published_date < f.first_entity_published_date
		        )::int AS processable_missing_before_first_entity,
		        MIN(p.published_date) AS oldest_processable_missing_published_date,
		        MAX(p.published_date) AS newest_processable_missing_published_date
		   FROM first_entity f
		   LEFT JOIN processable_backlog p ON true
		  GROUP BY f.first_entity_published_date`,
		[],
	);

	const backfillSourceTypes = await db.query<EntityQualityBackfillSourceTypeRow>(
		`WITH first_entity AS (
		   SELECT MIN(published_date) AS first_entity_published_date
		     FROM ${ARTICLES_TABLE}
		    WHERE jsonb_typeof(entities) = 'array'
		      AND jsonb_array_length(entities) > 0
		 ),
		 processable_backlog AS (
		   SELECT COALESCE(NULLIF(TRIM(a.source_type), ''), 'unknown') AS source_type,
		          a.published_date
		     FROM ${ARTICLES_TABLE} a
		    WHERE (a.content IS NOT NULL OR a.summary IS NOT NULL)
		      AND (
		        a.entities IS NULL
		        OR jsonb_typeof(a.entities) <> 'array'
		        OR CASE
		          WHEN jsonb_typeof(a.entities) = 'array' THEN jsonb_array_length(a.entities) = 0
		          ELSE false
		        END
		      )
		 )
		 SELECT p.source_type,
		        COUNT(*)::int AS processable_missing_or_empty,
		        COUNT(*) FILTER (
		          WHERE f.first_entity_published_date IS NOT NULL
		            AND p.published_date < f.first_entity_published_date
		        )::int AS processable_missing_before_first_entity,
		        MIN(p.published_date) AS oldest_processable_missing_published_date,
		        MAX(p.published_date) AS newest_processable_missing_published_date
		   FROM processable_backlog p
		   CROSS JOIN first_entity f
		  GROUP BY p.source_type
		  ORDER BY processable_missing_or_empty DESC, p.source_type ASC`,
		[],
	);

	const recommendedExtensions = ['pg_trgm', 'vector'];
	const extensions = await db.query<EntityQualityExtensionRow>(
		`SELECT extname
		   FROM pg_extension
		  WHERE extname = ANY($1::text[])
		  ORDER BY extname ASC`,
		[recommendedExtensions],
	);
	const installedExtensions = new Set(extensions.rows.map((entry) => entry.extname));
	const row = overview.rows[0];
	return {
		overview: {
			totalArticles: intValue(row?.total_articles),
			withEntityJson: intValue(row?.with_entity_json),
			emptyEntityJson: intValue(row?.empty_entity_json),
			missingEntityJson: intValue(row?.missing_entity_json),
			invalidEntityJson: intValue(row?.invalid_entity_json),
			jsonWithoutLinks: intValue(row?.json_without_links),
			maxEntitiesPerArticle: intValue(row?.max_entities_per_article),
			overCapArticles: intValue(row?.over_cap_articles),
			totalEntities: intValue(row?.total_entities),
			totalEntityLinks: intValue(row?.total_entity_links),
			orphanEntities: intValue(row?.orphan_entities),
			articleCountDrift: intValue(row?.article_count_drift),
			selfSourceExactLinks: intValue(row?.self_source_exact_links),
			genericEntityLinks: intValue(row?.generic_entity_links),
		},
		monthly: monthly.rows.map((entry) => {
			const totalArticles = intValue(entry.total_articles);
			const withEntityJson = intValue(entry.with_entity_json);
			return {
				month: entry.month,
				totalArticles,
				withEntityJson,
				emptyEntityJson: intValue(entry.empty_entity_json),
				missingOrInvalidEntityJson: intValue(entry.missing_or_invalid_entity_json),
				jsonWithoutLinks: intValue(entry.json_without_links),
				coverage: totalArticles ? withEntityJson / totalArticles : 0,
			};
		}),
		sourceTypes: sourceTypes.rows.map((entry) => {
			const totalArticles = intValue(entry.total_articles);
			const withEntityJson = intValue(entry.with_entity_json);
			return {
				sourceType: entry.source_type,
				totalArticles,
				withEntityJson,
				emptyEntityJson: intValue(entry.empty_entity_json),
				missingOrInvalidEntityJson: intValue(entry.missing_or_invalid_entity_json),
				jsonWithoutLinks: intValue(entry.json_without_links),
				coverage: totalArticles ? withEntityJson / totalArticles : 0,
			};
		}),
		monthlySourceTypes: monthlySourceTypes.rows.map((entry) => {
			const totalArticles = intValue(entry.total_articles);
			const withEntityJson = intValue(entry.with_entity_json);
			return {
				month: entry.month,
				sourceType: entry.source_type,
				totalArticles,
				withEntityJson,
				emptyEntityJson: intValue(entry.empty_entity_json),
				missingOrInvalidEntityJson: intValue(entry.missing_or_invalid_entity_json),
				jsonWithoutLinks: intValue(entry.json_without_links),
				coverage: totalArticles ? withEntityJson / totalArticles : 0,
			};
		}),
		unknownTypes: unknownTypes.rows.map((entry) => ({
			type: entry.type,
			count: intValue(entry.count),
			linkedArticleCount: intValue(entry.linked_article_count),
			examples: examplesByType.get(entry.type) ?? [],
		})),
		topOffenders: {
			selfSource: selfSourceOffenders.rows.map((entry) => ({
				canonicalName: entry.canonical_name,
				name: entry.name,
				source: entry.source,
				links: intValue(entry.links),
			})),
			generic: genericOffenders.rows.map((entry) => ({
				canonicalName: entry.canonical_name,
				name: entry.name,
				links: intValue(entry.links),
			})),
		},
		syncGaps: {
			jsonWithoutLinks: jsonWithoutLinkExamples.rows.map(articleExampleValue),
		},
		limitViolations: {
			overCapArticles: overCapExamples.rows.map(articleExampleValue),
		},
		entityRows: {
			orphanEntities: orphanEntityExamples.rows.map((entry) => ({
				canonicalName: entry.canonical_name,
				name: entry.name,
				nameCn: entry.name_cn,
				type: entry.type,
				articleCount: intValue(entry.article_count),
				updatedAt: isoDateValue(entry.updated_at),
			})),
		},
		backfill: {
			firstEntityPublishedDate: isoDateValue(backfill.rows[0]?.first_entity_published_date),
			processableMissingOrEmpty: intValue(backfill.rows[0]?.processable_missing_or_empty),
			processableMissingBeforeFirstEntityDate: intValue(backfill.rows[0]?.processable_missing_before_first_entity),
			oldestProcessableMissingPublishedDate: isoDateValue(backfill.rows[0]?.oldest_processable_missing_published_date),
			newestProcessableMissingPublishedDate: isoDateValue(backfill.rows[0]?.newest_processable_missing_published_date),
			sourceTypes: backfillSourceTypes.rows.map((entry) => ({
				sourceType: entry.source_type,
				processableMissingOrEmpty: intValue(entry.processable_missing_or_empty),
				processableMissingBeforeFirstEntityDate: intValue(entry.processable_missing_before_first_entity),
				oldestProcessableMissingPublishedDate: isoDateValue(entry.oldest_processable_missing_published_date),
				newestProcessableMissingPublishedDate: isoDateValue(entry.newest_processable_missing_published_date),
			})),
		},
		database: {
			extensions: {
				pgTrgm: installedExtensions.has('pg_trgm'),
				vector: installedExtensions.has('vector'),
			},
			missingRecommendedExtensions: recommendedExtensions.filter((extension) => !installedExtensions.has(extension)),
		},
	};
}
