\set ON_ERROR_STOP on

BEGIN;

WITH localization_source AS (
	SELECT
		state.resource_id,
		(
			resource.scope = 'corpus'
			AND resource.type IN ('web', 'rss', 'twitter', 'hackernews')
			AND resource.url IS NOT NULL
			AND resource.original_lang <> 'zh-Hant'
		) AS requires_localization,
		(
			NULLIF(BTRIM(original.title), '') IS NOT NULL
			AND NULLIF(BTRIM(original.content), '') IS NOT NULL
		) AS has_usable_content,
		CASE
			WHEN resource.scope = 'corpus'
			 AND resource.type IN ('web', 'rss', 'twitter', 'hackernews')
			 AND resource.url IS NOT NULL
			 AND resource.original_lang <> 'zh-Hant'
			 AND NULLIF(BTRIM(original.title), '') IS NOT NULL
			 AND NULLIF(BTRIM(original.content), '') IS NOT NULL
				THEN md5(original.content)
			ELSE NULL
		END AS actual_source_content_hash
	FROM resource_localization_state state
	JOIN resources resource ON resource.id = state.resource_id
	JOIN resource_translations original
	  ON original.resource_id = resource.id
	 AND original.lang = resource.original_lang
), repaired AS (
	UPDATE resource_localization_state state
	SET status = CASE
			WHEN NOT source.requires_localization THEN 'not_required'
			WHEN NOT source.has_usable_content THEN 'blocked_on_content'
			WHEN state.source_content_hash = source.actual_source_content_hash THEN 'complete'
			ELSE 'pending'
		END,
		current_source_content_hash = source.actual_source_content_hash,
		attempt_content_hash = NULL,
		attempts = 0,
		last_attempt_at = NULL,
		completed_at = CASE
			WHEN state.source_content_hash = source.actual_source_content_hash THEN state.completed_at
			ELSE NULL
		END,
		error = NULL,
		updated_at = NOW()
	FROM localization_source source
	WHERE state.resource_id = source.resource_id
	  AND state.current_source_content_hash IS DISTINCT FROM source.actual_source_content_hash
	RETURNING state.resource_id, state.status
)
SELECT
	count(*) AS repaired_rows,
	count(*) FILTER (WHERE status = 'pending') AS pending_rows,
	count(*) FILTER (WHERE status = 'complete') AS complete_rows,
	count(*) FILTER (WHERE status IN ('blocked_on_content', 'not_required')) AS terminal_rows
FROM repaired;

WITH normalized_attempts AS (
	UPDATE resource_localization_state
	SET attempts = 1,
		last_attempt_at = COALESCE(last_attempt_at, updated_at),
		updated_at = NOW()
	WHERE status IN ('queued', 'running', 'failed')
	  AND attempt_content_hash IS NOT NULL
	  AND attempts < 1
	RETURNING resource_id
)
SELECT count(*) AS normalized_attempt_rows
FROM normalized_attempts;

COMMIT;
