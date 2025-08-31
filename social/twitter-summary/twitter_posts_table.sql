-- 在 Supabase 中執行這個 SQL 來創建 twitter_posts 表
-- 用於追蹤已發布到 Twitter 的文章，避免重複發布

CREATE TABLE IF NOT EXISTS twitter_posts (
    id BIGSERIAL PRIMARY KEY,
    article_id TEXT NOT NULL REFERENCES articles(id),
    tweet_ids TEXT[] NOT NULL,
    tweet_content TEXT NOT NULL,
    posted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    article_score INTEGER,
    
    -- 索引
    UNIQUE(article_id),
    INDEX idx_twitter_posts_posted_at ON twitter_posts(posted_at),
    INDEX idx_twitter_posts_article_id ON twitter_posts(article_id)
);

-- 可選：添加 RLS (Row Level Security) 如果需要的話
-- ALTER TABLE twitter_posts ENABLE ROW LEVEL SECURITY;