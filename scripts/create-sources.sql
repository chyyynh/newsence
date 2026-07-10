-- #225: replace RssList with platform-aligned sources table.
-- Additive phase: creates sources, backfills from "RssList", adds feed_sources.source_id.
-- Old column/table are dropped later by drop-rss-list.sql (run AFTER worker + app deploys).
-- Run: psql "$DIRECT_URL" -f scripts/create-sources.sql

BEGIN;

CREATE TABLE IF NOT EXISTS sources (
	id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	platform      text NOT NULL,
	handle        text NOT NULL,
	name          text NOT NULL,
	site_url      text,
	avatar_url    text,
	category      text,
	display_group text,
	enabled       boolean NOT NULL DEFAULT true,
	scraped_at    timestamptz,
	scrape_state  jsonb,
	created_at    timestamptz NOT NULL DEFAULT now(),
	updated_at    timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT sources_platform_handle_key UNIQUE (platform, handle),
	CONSTRAINT sources_platform_check CHECK (platform IN ('rss', 'twitter', 'youtube'))
);

INSERT INTO sources (platform, handle, name, site_url, avatar_url, category, display_group, enabled, scraped_at)
SELECT
	CASE rl.type
		WHEN 'rss' THEN 'rss'
		WHEN 'twitter_user' THEN 'twitter'
		WHEN 'youtube_channel' THEN 'youtube'
	END,
	rl."RSSLink",
	rl.name,
	rl.url,
	rl.avatar_url,
	CASE WHEN rl.type = 'rss' THEN rl.media_type ELSE NULL END,
	rl.display_group,
	rl.is_default,
	rl.scraped_at AT TIME ZONE 'utc'
FROM "RssList" rl
ON CONFLICT (platform, handle) DO NOTHING;

DO $$
DECLARE
	rss_list_count bigint;
	sources_count bigint;
BEGIN
	SELECT count(*) INTO rss_list_count FROM "RssList";
	SELECT count(*) INTO sources_count FROM sources;
	IF sources_count <> rss_list_count THEN
		RAISE EXCEPTION 'sources backfill mismatch: RssList has % rows, sources has %', rss_list_count, sources_count;
	END IF;
END $$;

ALTER TABLE feed_sources ADD COLUMN IF NOT EXISTS source_id uuid;

UPDATE feed_sources fs
SET source_id = s.id
FROM "RssList" rl
JOIN sources s
	ON s.platform = CASE rl.type
		WHEN 'rss' THEN 'rss'
		WHEN 'twitter_user' THEN 'twitter'
		WHEN 'youtube_channel' THEN 'youtube'
	END
	AND s.handle = rl."RSSLink"
WHERE fs.rss_list_id = rl.id
  AND fs.source_id IS NULL;

DO $$
DECLARE
	unmapped bigint;
BEGIN
	SELECT count(*) INTO unmapped FROM feed_sources WHERE source_id IS NULL;
	IF unmapped > 0 THEN
		RAISE EXCEPTION 'feed_sources backfill left % rows without source_id', unmapped;
	END IF;
END $$;

ALTER TABLE feed_sources ALTER COLUMN source_id SET NOT NULL;
ALTER TABLE feed_sources
	ADD CONSTRAINT feed_sources_source_id_fkey
	FOREIGN KEY (source_id) REFERENCES sources(id) ON UPDATE CASCADE ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS feed_sources_feed_id_source_id_key ON feed_sources (feed_id, source_id);
CREATE INDEX IF NOT EXISTS feed_sources_source_id_idx ON feed_sources (source_id);

-- New writes stop populating rss_list_id; column stays until drop-rss-list.sql.
ALTER TABLE feed_sources ALTER COLUMN rss_list_id DROP NOT NULL;

COMMIT;
