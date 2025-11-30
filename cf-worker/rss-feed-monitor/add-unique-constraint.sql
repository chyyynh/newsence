-- Add UNIQUE constraint on URL to prevent duplicate articles
-- This will prevent the same article (with same URL) from being inserted twice

-- Step 1: First, clean up existing duplicates using the previous delete script
-- (Run delete-duplicates.sql first)

-- Step 2: Add a unique index on URL
-- This will prevent future duplicates at the database level
CREATE UNIQUE INDEX IF NOT EXISTS articles_url_unique_idx ON articles(url);

-- Note: If you get an error saying duplicates still exist,
-- you need to run the delete-duplicates.sql first to clean them up

-- Step 3: Verify the index was created
SELECT
    indexname,
    indexdef
FROM pg_indexes
WHERE tablename = 'articles'
AND indexname = 'articles_url_unique_idx';
