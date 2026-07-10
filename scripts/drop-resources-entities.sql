\set ON_ERROR_STOP on

BEGIN;

LOCK TABLE resources IN ACCESS EXCLUSIVE MODE NOWAIT;

DROP VIEW resources_localized;

ALTER TABLE resources DROP COLUMN IF EXISTS entities;

CREATE VIEW resources_localized AS
SELECT
  r.id,
  r.type,
  r.scope,
  r.url,
  r.normalized_url,
  r.storage_key,
  r.file_type,
  r.original_lang,
  rt.lang,
  rt.title,
  rt.summary,
  rt.content,
  rt.keywords,
  rt.source AS translation_source,
  r.published_date,
  r.scraped_date,
  r.tags,
  r.category,
  r.og_image_url,
  r.platform_metadata,
  r.enrichment_status,
  r.created_at,
  r.updated_at
FROM resources r
JOIN resource_translations rt ON rt.resource_id = r.id;

COMMIT;
