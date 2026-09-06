-- migrations/0004_playback_meta.sql —— 为播放历史增加标题、番剧名称、封面与媒体地址字段，用于首页快速续播
ALTER TABLE playback_history ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE playback_history ADD COLUMN subject_name TEXT NOT NULL DEFAULT '';
ALTER TABLE playback_history ADD COLUMN cover_url TEXT;
ALTER TABLE playback_history ADD COLUMN media_url TEXT NOT NULL DEFAULT '';
