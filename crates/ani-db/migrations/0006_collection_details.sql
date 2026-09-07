-- migrations/0006_collection_details.sql —— 追番条目多态收藏类型、评分、短评与私密标记
ALTER TABLE subject_collection ADD COLUMN collection_type INTEGER NOT NULL DEFAULT 3;
ALTER TABLE subject_collection ADD COLUMN rate INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subject_collection ADD COLUMN comment TEXT NOT NULL DEFAULT '';
ALTER TABLE subject_collection ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
