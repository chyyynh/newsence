\set ON_ERROR_STOP on

BEGIN;

INSERT INTO entity_translations (entity_id, lang, name, source, created_at, updated_at)
SELECT id, 'en', name, 'original', now(), now()
FROM entities
ON CONFLICT (entity_id, lang) DO NOTHING;

INSERT INTO entity_translations (entity_id, lang, name, source, created_at, updated_at)
SELECT id, 'zh-Hant', name_cn, 'machine', now(), now()
FROM entities
WHERE NULLIF(trim(name_cn), '') IS NOT NULL
ON CONFLICT (entity_id, lang) DO NOTHING;

COMMIT;

BEGIN;

LOCK TABLE entities IN ACCESS EXCLUSIVE MODE NOWAIT;

-- Close the race between the unlocked backfill and the schema cutover.
INSERT INTO entity_translations (entity_id, lang, name, source, created_at, updated_at)
SELECT id, 'en', name, 'original', now(), now()
FROM entities
ON CONFLICT (entity_id, lang) DO NOTHING;

INSERT INTO entity_translations (entity_id, lang, name, source, created_at, updated_at)
SELECT id, 'zh-Hant', name_cn, 'machine', now(), now()
FROM entities
WHERE NULLIF(trim(name_cn), '') IS NOT NULL
ON CONFLICT (entity_id, lang) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM entities entity_row
    LEFT JOIN entity_translations translation
      ON translation.entity_id = entity_row.id
     AND translation.lang = 'zh-Hant'
    WHERE NULLIF(trim(entity_row.name_cn), '') IS NOT NULL
      AND translation.entity_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot retire entities.name_cn: untranslated labels remain';
  END IF;
END $$;

ALTER TABLE entities DROP COLUMN name_cn;

COMMIT;
