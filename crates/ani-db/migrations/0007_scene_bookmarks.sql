-- migrations/0007_scene_bookmarks.sql —— 观影高能名场面打点书签与台词备忘
CREATE TABLE IF NOT EXISTS scene_bookmark (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id INTEGER,
    episode_id INTEGER,
    video_path TEXT,
    title TEXT NOT NULL,
    position_seconds REAL NOT NULL,
    created_at INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_scene_bookmark_subj_ep ON scene_bookmark(subject_id, episode_id);
CREATE INDEX IF NOT EXISTS idx_scene_bookmark_video ON scene_bookmark(video_path);
