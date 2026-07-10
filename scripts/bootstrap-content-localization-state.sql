\set ON_ERROR_STOP on

WITH seedable AS (
	SELECT
		resource.id AS resource_id,
		md5(original.content) AS current_source_content_hash,
		(
			zh.source = 'human'
			OR (
				NULLIF(BTRIM(zh.title), '') IS NOT NULL
				AND NULLIF(BTRIM(zh.summary), '') IS NOT NULL
				AND NULLIF(BTRIM(zh.content), '') IS NOT NULL
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
), upserted AS (
	INSERT INTO resource_localization_state AS state (
		resource_id,
		status,
		current_source_content_hash,
		source_content_hash,
		attempt_content_hash,
		attempts,
		completed_at,
		error,
		created_at,
		updated_at
	)
	SELECT
		resource_id,
		CASE WHEN is_complete THEN 'complete' ELSE 'pending' END,
		current_source_content_hash,
		CASE WHEN is_complete THEN current_source_content_hash ELSE NULL END,
		CASE WHEN is_complete THEN current_source_content_hash ELSE NULL END,
		0,
		CASE WHEN is_complete THEN NOW() ELSE NULL END,
		NULL,
		NOW(),
		NOW()
	FROM seedable
	ON CONFLICT (resource_id) DO UPDATE SET
		status = CASE
			WHEN state.source_content_hash = excluded.current_source_content_hash THEN 'complete'
			WHEN state.current_source_content_hash IS NOT DISTINCT FROM excluded.current_source_content_hash THEN state.status
			ELSE 'pending'
		END,
		current_source_content_hash = excluded.current_source_content_hash,
		attempt_content_hash = CASE
			WHEN state.current_source_content_hash IS DISTINCT FROM excluded.current_source_content_hash THEN NULL
			ELSE state.attempt_content_hash
		END,
		attempts = CASE
			WHEN state.current_source_content_hash IS DISTINCT FROM excluded.current_source_content_hash THEN 0
			ELSE state.attempts
		END,
		last_attempt_at = CASE
			WHEN state.current_source_content_hash IS DISTINCT FROM excluded.current_source_content_hash THEN NULL
			ELSE state.last_attempt_at
		END,
		completed_at = CASE
			WHEN state.source_content_hash = excluded.current_source_content_hash THEN state.completed_at
			ELSE NULL
		END,
		error = CASE
			WHEN state.current_source_content_hash IS DISTINCT FROM excluded.current_source_content_hash THEN NULL
			ELSE state.error
		END,
		updated_at = NOW()
	RETURNING status
)
SELECT
	count(*) AS upserted_rows,
	count(*) FILTER (WHERE status = 'complete') AS complete_rows,
	count(*) FILTER (WHERE status = 'pending') AS pending_rows
FROM upserted;
