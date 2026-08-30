-- migrations/0001_init.sql —— 表清单沿用拆解文档 10.4 的 Room 实体（节选核心）

CREATE TABLE IF NOT EXISTS subject_collection (
    bangumi_id INTEGER PRIMARY KEY,
    name_cn    TEXT NOT NULL DEFAULT '',
    name       TEXT NOT NULL DEFAULT '',
    cover_url  TEXT,
    air_date   TEXT,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS episode_collection (
    id         INTEGER PRIMARY KEY,   -- bangumi episode id
    subject_id INTEGER NOT NULL REFERENCES subject_collection(bangumi_id),
    ep         REAL NOT NULL,
    kind       INTEGER NOT NULL DEFAULT 0,
    title      TEXT NOT NULL DEFAULT '',
    watched    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_episode_subject ON episode_collection(subject_id);

CREATE TABLE IF NOT EXISTS playback_history (
    episode_id       INTEGER PRIMARY KEY,
    position_seconds REAL NOT NULL DEFAULT 0,
    duration_seconds REAL,
    finished         INTEGER NOT NULL DEFAULT 0,
    updated_at       INTEGER NOT NULL
);

-- 离线挂起写队列（对应 PlaybackHistoryPendingOpEntity）：没网先记账，联网补报
CREATE TABLE IF NOT EXISTS playback_pending_op (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    op_kind    TEXT NOT NULL,          -- "report_progress" | "mark_watched" ...
    op_json    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pending_episode_op ON playback_pending_op(episode_id, op_kind);

CREATE TABLE IF NOT EXISTS danmaku (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    sender     TEXT,
    text       TEXT NOT NULL,
    time_ms    INTEGER NOT NULL,
    mode       TEXT NOT NULL DEFAULT 'scroll',
    color      INTEGER NOT NULL DEFAULT 16777215
);
CREATE INDEX IF NOT EXISTS idx_danmaku_episode ON danmaku(episode_id, time_ms);

CREATE TABLE IF NOT EXISTS search_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword    TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
);

-- BT 缓存元信息（对应 TorrentCacheInfoDao）；resume 数据归 librqbit，不在此重复存
CREATE TABLE IF NOT EXISTS torrent_cache_info (
    info_hash  TEXT PRIMARY KEY,
    title      TEXT NOT NULL DEFAULT '',
    state      TEXT NOT NULL DEFAULT 'downloading',  -- downloading | completed | seeding
    media_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS http_cache_state (
    url        TEXT PRIMARY KEY,
    bytes_done INTEGER NOT NULL DEFAULT 0,
    bytes_total INTEGER,
    state      TEXT NOT NULL DEFAULT 'downloading'
);

-- "这类内容偏好哪个源"（对应 PreferredWebMediaSource）
CREATE TABLE IF NOT EXISTS preferred_web_source (
    subject_pattern TEXT NOT NULL,
    source_id       TEXT NOT NULL,
    updated_at      INTEGER NOT NULL,
    PRIMARY KEY (subject_pattern, source_id)
);
