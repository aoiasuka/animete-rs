-- migrations/0005_subject_collection_flag.sql —— 区分追番收藏与外键占位
ALTER TABLE subject_collection ADD COLUMN collected INTEGER NOT NULL DEFAULT 1;
UPDATE subject_collection SET collected = 0 WHERE name_cn = '' AND name = '';
