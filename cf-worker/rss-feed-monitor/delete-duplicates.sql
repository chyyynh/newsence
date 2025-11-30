-- ⚠️ WARNING: This will DELETE duplicate articles!
-- This keeps the OLDEST article for each normalized URL and deletes the rest

-- First, let's see what will be deleted
WITH duplicates AS (
    SELECT
        id,
        source,
        title,
        url,
        scraped_date,
        -- Manually normalize URLs by removing query parameters
        split_part(url, '?', 1) as normalized_url,
        ROW_NUMBER() OVER (
            PARTITION BY split_part(url, '?', 1)
            ORDER BY scraped_date ASC
        ) as row_num
    FROM articles
)
SELECT
    source,
    COUNT(*) as articles_to_delete
FROM duplicates
WHERE row_num > 1
GROUP BY source
ORDER BY articles_to_delete DESC;

-- If the preview looks good, run this to DELETE:
WITH duplicates AS (
    SELECT
        id,
        split_part(url, '?', 1) as normalized_url,
        ROW_NUMBER() OVER (
            PARTITION BY split_part(url, '?', 1)
            ORDER BY scraped_date ASC
        ) as row_num
    FROM articles
)
DELETE FROM articles
WHERE id IN (
    SELECT id
    FROM duplicates
    WHERE row_num > 1
);

-- After deletion, verify no duplicates remain:
SELECT
    split_part(url, '?', 1) as normalized_url,
    COUNT(*) as count
FROM articles
GROUP BY split_part(url, '?', 1)
HAVING COUNT(*) > 1
LIMIT 10;
