-- #225 final phase: retire "RssList" after create-sources.sql has run AND both the
-- core worker and web-tanstack deploys that read `sources` are live.
-- Destructive — verify first:
--   SELECT count(*) FROM feed_sources WHERE source_id IS NULL;  -- must be 0
--   SELECT max(scraped_at) FROM sources;                        -- must be advancing (crons write here)
-- Run: psql "$DIRECT_URL" -f scripts/drop-rss-list.sql

BEGIN;

DO $$
DECLARE
	unmapped bigint;
BEGIN
	SELECT count(*) INTO unmapped FROM feed_sources WHERE source_id IS NULL;
	IF unmapped > 0 THEN
		RAISE EXCEPTION 'feed_sources still has % rows without source_id — abort', unmapped;
	END IF;
END $$;

ALTER TABLE feed_sources DROP CONSTRAINT IF EXISTS feed_sources_rss_list_id_fkey;
ALTER TABLE feed_sources DROP COLUMN IF EXISTS rss_list_id;
DROP TABLE IF EXISTS "RssList";

COMMIT;
