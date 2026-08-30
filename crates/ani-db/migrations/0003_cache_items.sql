-- 离线缓存清单（HTTP/HLS 引擎；文件本体在 cache/<id>/ 目录）。
CREATE TABLE IF NOT EXISTS cache_items (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    kind       TEXT NOT NULL,
    url        TEXT NOT NULL,
    entry      TEXT NOT NULL DEFAULT '',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
