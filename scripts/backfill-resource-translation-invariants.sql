\set ON_ERROR_STOP on

BEGIN;

WITH sanitized AS (
	SELECT
		resource_id,
		lang,
		NULLIF(
			BTRIM(
				regexp_replace(
					regexp_replace(
						regexp_replace(
							regexp_replace(
								content,
								$markdown$!\[[^\r\n]*\]\(\s*data:image/[^)]*\)$markdown$,
								'',
								'gi'
							),
							$html_double$<img[^>]*src\s*=\s*"data:image/[^"]*"[^>]*>$html_double$,
							'',
							'gi'
						),
						$html_single$<img[^>]*src\s*=\s*'data:image/[^']*'[^>]*>$html_single$,
						'',
						'gi'
					),
					E'\n{3,}',
					E'\n\n',
					'g'
				)
			),
			''
		) AS content
	FROM resource_translations
	WHERE content ILIKE '%data:image/%'
), updated_content AS (
	UPDATE resource_translations translation
	SET content = sanitized.content,
		updated_at = NOW()
	FROM sanitized
	WHERE translation.resource_id = sanitized.resource_id
	  AND translation.lang = sanitized.lang
	RETURNING translation.resource_id
), demoted_sources AS (
	UPDATE resource_translations translation
	SET source = 'machine',
		updated_at = NOW()
	FROM resources resource
	WHERE resource.id = translation.resource_id
	  AND translation.source = 'original'
	  AND translation.lang <> resource.original_lang
	RETURNING translation.resource_id
)
SELECT
	(SELECT count(*) FROM updated_content) AS sanitized_rows,
	(SELECT count(*) FROM demoted_sources) AS demoted_source_rows;

DO $assert$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM resource_translations
		WHERE content ILIKE '%data:image/%'
	) THEN
		RAISE EXCEPTION 'resource translation inline data images remain';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM resource_translations translation
		JOIN resources resource ON resource.id = translation.resource_id
		WHERE translation.source = 'original'
		  AND translation.lang <> resource.original_lang
	) THEN
		RAISE EXCEPTION 'misplaced original translation sources remain';
	END IF;
END
$assert$;

COMMIT;
