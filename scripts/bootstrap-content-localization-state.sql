\set ON_ERROR_STOP on
\if :{?seed_limit}
\else
\set seed_limit 2147483647
\endif

CREATE TEMP TABLE content_localization_state_seed AS
WITH seedable AS (
	SELECT
		resource.id,
		md5(original.content) AS source_content_hash,
		(
			zh.source = 'human'
			OR (
				NULLIF(BTRIM(zh.title), '') IS NOT NULL
				AND NULLIF(BTRIM(zh.summary), '') IS NOT NULL
				AND NULLIF(BTRIM(zh.content), '') IS NOT NULL
				AND zh.content NOT ILIKE '%data:image/%'
				AND (
					length(original.content) < 1000
					OR length(zh.content)::numeric / GREATEST(length(original.content), 1) >= 0.2
				)
			)
		) AS is_complete
	FROM resources resource
	JOIN resource_translations original
	  ON original.resource_id = resource.id
	 AND original.lang = resource.original_lang
	LEFT JOIN resource_translations zh
	  ON zh.resource_id = resource.id
	 AND zh.lang = 'zh-Hant'
	WHERE resource.enrichment_status = 'enriched'
	  AND resource.scope = 'corpus'
	  AND resource.type IN ('rss', 'hackernews', 'web', 'twitter')
	  AND resource.url IS NOT NULL
	  AND resource.original_lang <> 'zh-Hant'
	  AND NULLIF(BTRIM(original.title), '') IS NOT NULL
	  AND NULLIF(BTRIM(original.content), '') IS NOT NULL
	  AND original.content NOT ILIKE '%data:image/%'
), numbered AS (
	SELECT
		id,
		source_content_hash,
		is_complete,
		(row_number() OVER (ORDER BY id) - 1) / 500 AS batch_number
	FROM seedable
)
SELECT id, source_content_hash, is_complete, batch_number
FROM numbered
LIMIT :seed_limit;

CREATE INDEX content_localization_state_seed_batch_idx
	ON content_localization_state_seed (batch_number);

SELECT format(
	$sql$
	WITH candidates AS (
		SELECT resource.id, seed.source_content_hash, seed.is_complete
		FROM resources resource
		JOIN content_localization_state_seed seed ON seed.id = resource.id
		WHERE seed.batch_number = %s
		  AND (
			resource.platform_metadata #>> '{contentLocalization,currentSourceContentHash}' IS DISTINCT FROM seed.source_content_hash
			OR (
				seed.is_complete
				AND resource.platform_metadata #>> '{contentLocalization,sourceContentHash}' IS DISTINCT FROM seed.source_content_hash
			)
		  )
		FOR UPDATE OF resource SKIP LOCKED
	)
	UPDATE resources resource
	SET platform_metadata = jsonb_set(
		COALESCE(resource.platform_metadata, '{}'::jsonb),
		'{contentLocalization}',
		COALESCE(resource.platform_metadata->'contentLocalization', '{}'::jsonb)
			|| jsonb_build_object(
				'status', CASE WHEN candidates.is_complete THEN 'complete' ELSE 'pending' END,
				'currentSourceContentHash', candidates.source_content_hash,
				'completedAt', CASE
					WHEN candidates.is_complete THEN COALESCE(
						resource.platform_metadata #>> '{contentLocalization,completedAt}',
						NOW()::text
					)
					ELSE NULL
				END,
				'error', NULL
			)
			|| CASE
				WHEN candidates.is_complete THEN jsonb_build_object(
					'sourceContentHash', candidates.source_content_hash,
					'attemptContentHash', candidates.source_content_hash
				)
				ELSE '{}'::jsonb
			END,
		true
	)
	FROM candidates
	WHERE resource.id = candidates.id;
	$sql$,
	batch_number
)
FROM (
	SELECT DISTINCT batch_number
	FROM content_localization_state_seed
	ORDER BY batch_number
) batches
\gexec

DROP TABLE content_localization_state_seed;
