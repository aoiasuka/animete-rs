-- 弹幕缓存：按查询键（dandanplay 匹配结果）整包存 JSON，避免重复请求触发限流。
CREATE TABLE IF NOT EXISTS danmaku_cache (
    cache_key     TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    comments_json TEXT NOT NULL,
    fetched_at    INTEGER NOT NULL
);
