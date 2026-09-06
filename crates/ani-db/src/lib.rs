//! ani-db —— SQLite 持久层（sqlx + 迁移）。
//!
//! 坑 4（蓝图 13.2）：开 WAL + busy_timeout；仓库层（ani-repo，后续里程碑）
//! 负责把 Row 类型转成 ani-core 的领域模型，别让 sqlx 类型漏进 core。

use anyhow::Context;
use sqlx::{
    migrate::MigrateDatabase,
    sqlite::{
        SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous,
    },
};
use std::{path::PathBuf, str::FromStr, time::Duration};

/// 默认数据库路径：%APPDATA%/ani-rs/ani.db（对应 AppFolderResolver）。
pub fn default_db_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("ani-rs")
        .join("ani.db")
}

/// 运行时迁移：把 migrations/*.sql 内嵌进二进制（include_str），不依赖 sqlx::migrate! 的路径解析。
async fn run_migrations(pool: &SqlitePool) -> anyhow::Result<()> {
    sqlx::raw_sql(
        r#"
        CREATE TABLE IF NOT EXISTS _ani_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
        "#,
    )
    .execute(pool)
    .await?;
    for (name, sql) in MIGRATIONS {
        let applied =
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM _ani_migrations WHERE version = ?1")
                .bind(name)
                .fetch_one(pool)
                .await?;
        if applied == 0 {
            // DDL 与版本记录同事务：中途崩溃不会留下"半迁移且无记录"的库
            let mut tx = pool.begin().await?;
            sqlx::raw_sql(sql).execute(&mut *tx).await?;
            sqlx::query("INSERT INTO _ani_migrations (version, applied_at) VALUES (?1, ?2)")
                .bind(name)
                .bind(chrono::Utc::now().timestamp_millis())
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            tracing::info!("applied migration {name}");
        }
    }
    Ok(())
}

static MIGRATIONS: &[(&str, &str)] = &[
    ("0001_init", include_str!("../migrations/0001_init.sql")),
    (
        "0002_danmaku_cache",
        include_str!("../migrations/0002_danmaku_cache.sql"),
    ),
    (
        "0003_cache_items",
        include_str!("../migrations/0003_cache_items.sql"),
    ),
    (
        "0004_playback_meta",
        include_str!("../migrations/0004_playback_meta.sql"),
    ),
    (
        "0005_subject_collection_flag",
        include_str!("../migrations/0005_subject_collection_flag.sql"),
    ),
];

pub async fn open(path: &std::path::Path) -> anyhow::Result<SqlitePool> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }
    let url = format!("sqlite://{}", path.to_string_lossy().replace('\\', "/"));
    if !sqlx::sqlite::Sqlite::database_exists(&url).await? {
        sqlx::sqlite::Sqlite::create_database(&url).await?;
    }
    let opts = SqliteConnectOptions::from_str(&url)?
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(opts)
        .await
        .context("connect sqlite failed")?;
    run_migrations(&pool).await?;
    // 清理历史残留的无效空追番条目
    let _ = sqlx::query("DELETE FROM subject_collection WHERE name_cn = '' AND name = ''")
        .execute(&pool)
        .await;
    Ok(pool)
}

/// 播放记录展示项（用于首页「继续观看」与历史清单）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PlaybackHistoryItem {
    pub episode_id: i64,
    pub position_seconds: f64,
    pub duration_seconds: Option<f64>,
    pub finished: bool,
    pub updated_at: i64,
    pub title: String,
    pub subject_name: String,
    pub cover_url: Option<String>,
    pub media_url: String,
}

/// 播放进度读写（对应 PlaybackHistoryDao）。
pub struct PlaybackRepo {
    pool: SqlitePool,
}

impl PlaybackRepo {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn save_position(&self, pos: &ani_core::PlaybackPosition) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO playback_history (episode_id, position_seconds, duration_seconds, finished, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(episode_id) DO UPDATE SET
               position_seconds=?2, duration_seconds=?3, finished=?4, updated_at=?5",
        )
        .bind(pos.episode_id.0 as i64)
        .bind(pos.position_seconds)
        .bind(pos.duration_seconds)
        .bind(pos.finished as i64)
        .bind(pos.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// 保存播放进度并附带番剧/媒体元数据（用于首页展示卡片和快速续播）。
    pub async fn save_position_with_meta(
        &self,
        pos: &ani_core::PlaybackPosition,
        title: &str,
        subject_name: &str,
        cover_url: Option<&str>,
        media_url: &str,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO playback_history (episode_id, position_seconds, duration_seconds, finished, updated_at, title, subject_name, cover_url, media_url)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(episode_id) DO UPDATE SET
               position_seconds=?2, duration_seconds=?3, finished=?4, updated_at=?5,
               title=CASE WHEN ?6 != '' THEN ?6 ELSE playback_history.title END,
               subject_name=CASE WHEN ?7 != '' THEN ?7 ELSE playback_history.subject_name END,
               cover_url=COALESCE(?8, playback_history.cover_url),
               media_url=CASE WHEN ?9 != '' THEN ?9 ELSE playback_history.media_url END",
        )
        .bind(pos.episode_id.0 as i64)
        .bind(pos.position_seconds)
        .bind(pos.duration_seconds)
        .bind(pos.finished as i64)
        .bind(pos.updated_at)
        .bind(title)
        .bind(subject_name)
        .bind(cover_url)
        .bind(media_url)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// 查询最近播放历史（有一定播放进度的记录，新→旧）。
    pub async fn list_recent(&self, limit: i64) -> anyhow::Result<Vec<PlaybackHistoryItem>> {
        let rows = sqlx::query_as::<_, (i64, f64, Option<f64>, i64, i64, String, String, Option<String>, String)>(
            "SELECT episode_id, position_seconds, duration_seconds, finished, updated_at, title, subject_name, cover_url, media_url
             FROM playback_history
             WHERE position_seconds > 3.0 AND finished = 0
             ORDER BY updated_at DESC
             LIMIT ?1",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .into_iter()
            .map(
                |(
                    episode_id,
                    position_seconds,
                    duration_seconds,
                    finished,
                    updated_at,
                    title,
                    subject_name,
                    cover_url,
                    media_url,
                )| PlaybackHistoryItem {
                    episode_id,
                    position_seconds,
                    duration_seconds,
                    finished: finished != 0,
                    updated_at,
                    title,
                    subject_name,
                    cover_url,
                    media_url,
                },
            )
            .collect())
    }

    /// 查询全部播放历史（包含已完成条目，新→旧）。
    pub async fn list_all(&self, limit: i64) -> anyhow::Result<Vec<PlaybackHistoryItem>> {
        let rows = sqlx::query_as::<_, (i64, f64, Option<f64>, i64, i64, String, String, Option<String>, String)>(
            "SELECT episode_id, position_seconds, duration_seconds, finished, updated_at, title, subject_name, cover_url, media_url
             FROM playback_history
             ORDER BY updated_at DESC
             LIMIT ?1",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .into_iter()
            .map(
                |(
                    episode_id,
                    position_seconds,
                    duration_seconds,
                    finished,
                    updated_at,
                    title,
                    subject_name,
                    cover_url,
                    media_url,
                )| PlaybackHistoryItem {
                    episode_id,
                    position_seconds,
                    duration_seconds,
                    finished: finished != 0,
                    updated_at,
                    title,
                    subject_name,
                    cover_url,
                    media_url,
                },
            )
            .collect())
    }

    pub async fn remove_item(&self, episode_id: i64) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM playback_history WHERE episode_id = ?1")
            .bind(episode_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn clear_all(&self) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM playback_history")
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn load_position(
        &self,
        episode_id: ani_core::EpisodeId,
    ) -> anyhow::Result<Option<ani_core::PlaybackPosition>> {
        let row = sqlx::query_as::<_, (f64, Option<f64>, i64, i64)>(
            "SELECT position_seconds, duration_seconds, finished, updated_at FROM playback_history WHERE episode_id = ?1",
        )
        .bind(episode_id.0 as i64)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(
            |(position_seconds, duration_seconds, finished, updated_at)| {
                ani_core::PlaybackPosition {
                    episode_id,
                    position_seconds,
                    duration_seconds,
                    finished: finished != 0,
                    updated_at,
                }
            },
        ))
    }

    /// 离线挂起写队列入账（对应 PendingOp）。
    pub async fn enqueue_pending_op(
        &self,
        episode_id: ani_core::EpisodeId,
        op_kind: &str,
        op: &serde_json::Value,
    ) -> anyhow::Result<()> {
        sqlx::query("INSERT INTO playback_pending_op (episode_id, op_kind, op_json, created_at) VALUES (?1, ?2, ?3, ?4)")
            .bind(episode_id.0 as i64)
            .bind(op_kind)
            .bind(op.to_string())
            .bind(chrono::Utc::now().timestamp_millis())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// 查询全部待同步的离线挂起操作（按创建时间升序）。
    pub async fn list_pending_ops(&self) -> anyhow::Result<Vec<PlaybackPendingOp>> {
        let rows = sqlx::query_as::<_, (i64, i64, String, String, i64, i64)>(
            "SELECT id, episode_id, op_kind, op_json, created_at, attempts FROM playback_pending_op ORDER BY created_at ASC",
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .into_iter()
            .map(
                |(id, episode_id, op_kind, op_json, created_at, attempts)| PlaybackPendingOp {
                    id,
                    episode_id,
                    op_kind,
                    op_json,
                    created_at,
                    attempts,
                },
            )
            .collect())
    }

    /// 标记一次同步重试（累加 attempts 尝试次数）。
    pub async fn inc_pending_op_attempts(&self, id: i64) -> anyhow::Result<()> {
        sqlx::query("UPDATE playback_pending_op SET attempts = attempts + 1 WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// 成功同步后从挂起队列移除。
    pub async fn remove_pending_op(&self, id: i64) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM playback_pending_op WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}

/// 离线挂起操作记录项。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct PlaybackPendingOp {
    pub id: i64,
    pub episode_id: i64,
    pub op_kind: String,
    pub op_json: String,
    pub created_at: i64,
    pub attempts: i64,
}

/// 弹幕缓存（整包 JSON，按查询键去重请求）。
pub struct DanmakuCacheRepo {
    pool: SqlitePool,
}

impl DanmakuCacheRepo {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// 命中返回 (title, comments_json, fetched_at 毫秒)。
    pub async fn get(&self, cache_key: &str) -> anyhow::Result<Option<(String, String, i64)>> {
        let row = sqlx::query_as::<_, (String, String, i64)>(
            "SELECT title, comments_json, fetched_at FROM danmaku_cache WHERE cache_key = ?1",
        )
        .bind(cache_key)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }

    pub async fn put(
        &self,
        cache_key: &str,
        title: &str,
        comments_json: &str,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO danmaku_cache (cache_key, title, comments_json, fetched_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(cache_key) DO UPDATE SET
               title=?2, comments_json=?3, fetched_at=?4",
        )
        .bind(cache_key)
        .bind(title)
        .bind(comments_json)
        .bind(chrono::Utc::now().timestamp_millis())
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

/// 离线缓存清单（HTTP/HLS 引擎；文件本体在 cache/<id>/ 目录）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct CacheItemRow {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub url: String,
    pub entry: String,
    pub size_bytes: i64,
    pub created_at: i64,
}

pub struct CacheItemRepo {
    pool: SqlitePool,
}

impl CacheItemRepo {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    const COLS: &'static str = "id, title, kind, url, entry, size_bytes, created_at";

    fn row(
        (id, title, kind, url, entry, size_bytes, created_at): (
            String,
            String,
            String,
            String,
            String,
            i64,
            i64,
        ),
    ) -> CacheItemRow {
        CacheItemRow {
            id,
            title,
            kind,
            url,
            entry,
            size_bytes,
            created_at,
        }
    }

    pub async fn get(&self, id: &str) -> anyhow::Result<Option<CacheItemRow>> {
        let row = sqlx::query_as::<_, (String, String, String, String, String, i64, i64)>(
            &format!("SELECT {} FROM cache_items WHERE id = ?1", Self::COLS),
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(Self::row))
    }

    /// 新建/覆盖（kind/entry 下载完成后由 update_finish 补齐）。
    pub async fn put(&self, id: &str, title: &str, url: &str) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO cache_items (id, title, kind, url, entry, size_bytes, created_at)
             VALUES (?1, ?2, 'pending', ?3, '', 0, ?4)
             ON CONFLICT(id) DO UPDATE SET title=?2, url=?3",
        )
        .bind(id)
        .bind(title)
        .bind(url)
        .bind(chrono::Utc::now().timestamp_millis())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn update_finish(
        &self,
        id: &str,
        kind: &str,
        entry: &str,
        size_bytes: i64,
    ) -> anyhow::Result<()> {
        sqlx::query("UPDATE cache_items SET kind=?2, entry=?3, size_bytes=?4 WHERE id=?1")
            .bind(id)
            .bind(kind)
            .bind(entry)
            .bind(size_bytes)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn remove(&self, id: &str) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM cache_items WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn clear_all(&self) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM cache_items")
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn list(&self) -> anyhow::Result<Vec<CacheItemRow>> {
        let rows =
            sqlx::query_as::<_, (String, String, String, String, String, i64, i64)>(&format!(
                "SELECT {} FROM cache_items ORDER BY created_at DESC",
                Self::COLS
            ))
            .fetch_all(&self.pool)
            .await?;
        Ok(rows.into_iter().map(Self::row).collect())
    }
}

/// 搜索历史（对应 SearchHistoryDao）：首页「最近搜索」。
pub struct SearchHistoryRepo {
    pool: SqlitePool,
}

impl SearchHistoryRepo {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// 记录一次搜索（同关键词刷新时间戳）。
    pub async fn record(&self, keyword: &str) -> anyhow::Result<()> {
        let kw = keyword.trim();
        if kw.is_empty() || kw.chars().count() > 100 {
            return Ok(());
        }
        sqlx::query(
            "INSERT INTO search_history (keyword, created_at) VALUES (?1, ?2)
             ON CONFLICT(keyword) DO UPDATE SET created_at = excluded.created_at",
        )
        .bind(kw)
        .bind(chrono::Utc::now().timestamp_millis())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// 最近 N 条（新→旧）。
    pub async fn list(&self, limit: i64) -> anyhow::Result<Vec<String>> {
        let rows = sqlx::query_as::<_, (String,)>(
            "SELECT keyword FROM search_history ORDER BY created_at DESC, id DESC LIMIT ?1",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|(k,)| k).collect())
    }

    pub async fn remove(&self, keyword: &str) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM search_history WHERE keyword = ?1")
            .bind(keyword.trim())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn clear(&self) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM search_history")
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}

/// 我的追番/收藏条目（对应 subject_collection 表）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SubjectCollectionItem {
    pub bangumi_id: i64,
    pub name_cn: String,
    pub name: String,
    pub cover_url: Option<String>,
    pub air_date: Option<String>,
    pub updated_at: i64,
}

/// 追番收藏读写仓库。
pub struct CollectionRepo {
    pool: SqlitePool,
}

impl CollectionRepo {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn save(&self, item: &SubjectCollectionItem) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO subject_collection (bangumi_id, name_cn, name, cover_url, air_date, updated_at, collected)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)
             ON CONFLICT(bangumi_id) DO UPDATE SET
               name_cn=?2, name=?3, cover_url=?4, air_date=?5, updated_at=?6, collected=1",
        )
        .bind(item.bangumi_id)
        .bind(&item.name_cn)
        .bind(&item.name)
        .bind(&item.cover_url)
        .bind(&item.air_date)
        .bind(item.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn remove(&self, bangumi_id: i64) -> anyhow::Result<()> {
        // 如果有剧集已看记录，则保留行以满足外键，仅将 collected 置为 0；若无剧集记录则彻底删除
        let ep_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM episode_collection WHERE subject_id = ?1",
        )
        .bind(bangumi_id)
        .fetch_one(&self.pool)
        .await?;

        if ep_count > 0 {
            sqlx::query("UPDATE subject_collection SET collected = 0 WHERE bangumi_id = ?1")
                .bind(bangumi_id)
                .execute(&self.pool)
                .await?;
        } else {
            sqlx::query("DELETE FROM subject_collection WHERE bangumi_id = ?1")
                .bind(bangumi_id)
                .execute(&self.pool)
                .await?;
        }
        Ok(())
    }

    pub async fn is_collected(&self, bangumi_id: i64) -> anyhow::Result<bool> {
        let count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM subject_collection WHERE bangumi_id = ?1 AND collected = 1",
        )
        .bind(bangumi_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(count > 0)
    }

    pub async fn list(&self) -> anyhow::Result<Vec<SubjectCollectionItem>> {
        let rows = sqlx::query_as::<_, (i64, String, String, Option<String>, Option<String>, i64)>(
            "SELECT bangumi_id, name_cn, name, cover_url, air_date, updated_at
             FROM subject_collection
             WHERE collected = 1
             ORDER BY updated_at DESC",
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .into_iter()
            .map(
                |(bangumi_id, name_cn, name, cover_url, air_date, updated_at)| {
                    SubjectCollectionItem {
                        bangumi_id,
                        name_cn,
                        name,
                        cover_url,
                        air_date,
                        updated_at,
                    }
                },
            )
            .collect())
    }
}

/// 剧集状态读写仓库（对应 episode_collection 表）。
pub struct EpisodeRepo {
    pool: SqlitePool,
}

impl EpisodeRepo {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// 标记某剧集已看/未看状态。
    pub async fn mark_watched(
        &self,
        episode_id: i64,
        subject_id: i64,
        ep: f64,
        watched: bool,
    ) -> anyhow::Result<()> {
        let now = chrono::Utc::now().timestamp_millis();
        // 外键占位行：collected 置为 0，不污染「我的追番」
        sqlx::query(
            "INSERT INTO subject_collection (bangumi_id, name_cn, name, updated_at, collected)
             VALUES (?1, '', '', ?2, 0)
             ON CONFLICT(bangumi_id) DO NOTHING",
        )
        .bind(subject_id)
        .bind(now)
        .execute(&self.pool)
        .await?;

        sqlx::query(
            "INSERT INTO episode_collection (id, subject_id, ep, watched)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET watched = ?4",
        )
        .bind(episode_id)
        .bind(subject_id)
        .bind(ep)
        .bind(if watched { 1i64 } else { 0i64 })
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// 列出某番剧所有已看的剧集 ID。
    pub async fn list_watched_by_subject(&self, subject_id: i64) -> anyhow::Result<Vec<i64>> {
        let rows = sqlx::query_scalar::<_, i64>(
            "SELECT id FROM episode_collection WHERE subject_id = ?1 AND watched = 1",
        )
        .bind(subject_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }
}

/// 用户数据备份容器（跨设备/重装迁移）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct UserDataBackup {
    pub version: u32,
    pub exported_at: i64,
    pub collections: Vec<SubjectCollectionItem>,
    pub playback_history: Vec<PlaybackHistoryItem>,
}

/// 导入结果统计。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ImportStats {
    pub collections_imported: usize,
    pub playback_imported: usize,
}

/// 用户数据导入导出仓库。
pub struct UserDataRepo {
    pool: SqlitePool,
}

impl UserDataRepo {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// 导出全部追番与播放历史。
    pub async fn export_backup(&self) -> anyhow::Result<UserDataBackup> {
        let col_repo = CollectionRepo::new(self.pool.clone());
        let collections = col_repo.list().await?;

        let rows = sqlx::query_as::<
            _,
            (
                i64,
                f64,
                Option<f64>,
                i64,
                i64,
                String,
                String,
                Option<String>,
                String,
            ),
        >(
            "SELECT episode_id, position_seconds, duration_seconds, finished, updated_at, title, subject_name, cover_url, media_url
             FROM playback_history
             ORDER BY updated_at DESC",
        )
        .fetch_all(&self.pool)
        .await?;

        let playback_history = rows
            .into_iter()
            .map(
                |(
                    episode_id,
                    position_seconds,
                    duration_seconds,
                    finished,
                    updated_at,
                    title,
                    subject_name,
                    cover_url,
                    media_url,
                )| PlaybackHistoryItem {
                    episode_id,
                    position_seconds,
                    duration_seconds,
                    finished: finished != 0,
                    updated_at,
                    title,
                    subject_name,
                    cover_url,
                    media_url,
                },
            )
            .collect();

        Ok(UserDataBackup {
            version: 1,
            exported_at: chrono::Utc::now().timestamp_millis(),
            collections,
            playback_history,
        })
    }

    /// 导入合并追番与播放历史。
    pub async fn import_backup(&self, backup: &UserDataBackup) -> anyhow::Result<ImportStats> {
        let col_repo = CollectionRepo::new(self.pool.clone());
        let mut collections_imported = 0;
        for col in &backup.collections {
            col_repo.save(col).await?;
            collections_imported += 1;
        }

        let mut playback_imported = 0;
        for item in &backup.playback_history {
            sqlx::query(
                "INSERT INTO playback_history (episode_id, position_seconds, duration_seconds, finished, updated_at, title, subject_name, cover_url, media_url)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(episode_id) DO UPDATE SET
                   position_seconds = CASE WHEN excluded.updated_at >= playback_history.updated_at THEN excluded.position_seconds ELSE playback_history.position_seconds END,
                   duration_seconds = COALESCE(excluded.duration_seconds, playback_history.duration_seconds),
                   finished = CASE WHEN excluded.updated_at >= playback_history.updated_at THEN excluded.finished ELSE playback_history.finished END,
                   updated_at = MAX(playback_history.updated_at, excluded.updated_at),
                   title = CASE WHEN excluded.title != '' THEN excluded.title ELSE playback_history.title END,
                   subject_name = CASE WHEN excluded.subject_name != '' THEN excluded.subject_name ELSE playback_history.subject_name END,
                   cover_url = COALESCE(excluded.cover_url, playback_history.cover_url),
                   media_url = CASE WHEN excluded.media_url != '' THEN excluded.media_url ELSE playback_history.media_url END",
            )
            .bind(item.episode_id)
            .bind(item.position_seconds)
            .bind(item.duration_seconds)
            .bind(if item.finished { 1i64 } else { 0i64 })
            .bind(item.updated_at)
            .bind(&item.title)
            .bind(&item.subject_name)
            .bind(&item.cover_url)
            .bind(&item.media_url)
            .execute(&self.pool)
            .await?;
            playback_imported += 1;
        }

        Ok(ImportStats {
            collections_imported,
            playback_imported,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_collection_repo_crud() {
        let pool = open(&std::path::PathBuf::from(":memory:")).await.unwrap();
        let repo = CollectionRepo::new(pool);

        assert!(!repo.is_collected(12345).await.unwrap());

        let item = SubjectCollectionItem {
            bangumi_id: 12345,
            name_cn: "芙莉莲".into(),
            name: "Sousou no Frieren".into(),
            cover_url: Some("http://example.com/cover.jpg".into()),
            air_date: Some("2023-09-29".into()),
            updated_at: 1000,
        };
        repo.save(&item).await.unwrap();

        assert!(repo.is_collected(12345).await.unwrap());
        let list = repo.list().await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name_cn, "芙莉莲");

        repo.remove(12345).await.unwrap();
        assert!(!repo.is_collected(12345).await.unwrap());
        assert_eq!(repo.list().await.unwrap().len(), 0);
    }

    #[tokio::test]
    async fn test_playback_repo_meta_and_recent() {
        let pool = open(&std::path::PathBuf::from(":memory:")).await.unwrap();
        let repo = PlaybackRepo::new(pool);

        let pos = ani_core::PlaybackPosition {
            episode_id: ani_core::EpisodeId(999),
            position_seconds: 120.5,
            duration_seconds: Some(1400.0),
            finished: false,
            updated_at: 2000,
        };
        repo.save_position_with_meta(
            &pos,
            "第 1 集",
            "葬送的芙莉莲",
            Some("http://example.com/c.jpg"),
            "http://example.com/video.mp4",
        )
        .await
        .unwrap();

        let recent = repo.list_recent(10).await.unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].title, "第 1 集");
        assert_eq!(recent[0].subject_name, "葬送的芙莉莲");
        assert_eq!(recent[0].position_seconds, 120.5);

        // 当看完时（finished = true），移出继续观看
        let pos_finished = ani_core::PlaybackPosition {
            episode_id: ani_core::EpisodeId(999),
            position_seconds: 1400.0,
            duration_seconds: Some(1400.0),
            finished: true,
            updated_at: 2001,
        };
        repo.save_position_with_meta(
            &pos_finished,
            "第 1 集",
            "葬送的芙莉莲",
            None,
            "http://example.com/video.mp4",
        )
        .await
        .unwrap();
        assert_eq!(repo.list_recent(10).await.unwrap().len(), 0);
        // 但全量播放历史中仍应记录已看完的条目
        let all = repo.list_all(10).await.unwrap();
        assert_eq!(all.len(), 1);
        assert!(all[0].finished);

        repo.remove_item(999).await.unwrap();
        assert_eq!(repo.list_recent(10).await.unwrap().len(), 0);
        assert_eq!(repo.list_all(10).await.unwrap().len(), 0);
    }

    #[tokio::test]
    async fn test_episode_repo_crud() {
        let pool = open(&std::path::PathBuf::from(":memory:")).await.unwrap();
        let repo = EpisodeRepo::new(pool.clone());
        let col_repo = CollectionRepo::new(pool);

        let watched = repo.list_watched_by_subject(400602).await.unwrap();
        assert_eq!(watched.len(), 0);

        repo.mark_watched(101, 400602, 1.0, true).await.unwrap();
        repo.mark_watched(102, 400602, 2.0, true).await.unwrap();

        // 标记已看不应向「我的追番」插入空白幽灵条目
        assert!(!col_repo.is_collected(400602).await.unwrap());
        assert_eq!(col_repo.list().await.unwrap().len(), 0);

        let watched = repo.list_watched_by_subject(400602).await.unwrap();
        assert_eq!(watched.len(), 2);
        assert!(watched.contains(&101));
        assert!(watched.contains(&102));

        // 切换为未看
        repo.mark_watched(101, 400602, 1.0, false).await.unwrap();
        let watched = repo.list_watched_by_subject(400602).await.unwrap();
        assert_eq!(watched.len(), 1);
        assert_eq!(watched[0], 102);
    }

    #[tokio::test]
    async fn test_search_history_repo_crud() {
        let pool = open(&std::path::PathBuf::from(":memory:")).await.unwrap();
        let repo = SearchHistoryRepo::new(pool);

        repo.record("芙莉莲").await.unwrap();
        repo.record("孤独摇滚").await.unwrap();
        let list = repo.list(10).await.unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0], "孤独摇滚"); // 最新在最前

        repo.remove("孤独摇滚").await.unwrap();
        let list = repo.list(10).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0], "芙莉莲");

        repo.clear().await.unwrap();
        let list = repo.list(10).await.unwrap();
        assert_eq!(list.len(), 0);
    }

    #[tokio::test]
    async fn test_user_data_export_import() {
        let pool = open(&std::path::PathBuf::from(":memory:")).await.unwrap();
        let user_repo = UserDataRepo::new(pool.clone());
        let col_repo = CollectionRepo::new(pool.clone());
        let pb_repo = PlaybackRepo::new(pool.clone());

        col_repo
            .save(&SubjectCollectionItem {
                bangumi_id: 400602,
                name_cn: "葬送的芙莉莲".into(),
                name: "Sousou no Frieren".into(),
                cover_url: Some("http://example.com/cover.jpg".into()),
                air_date: Some("2023-09-29".into()),
                updated_at: 1000,
            })
            .await
            .unwrap();

        pb_repo
            .save_position_with_meta(
                &ani_core::PlaybackPosition {
                    episode_id: ani_core::EpisodeId(888),
                    position_seconds: 240.0,
                    duration_seconds: Some(1420.0),
                    finished: false,
                    updated_at: 2000,
                },
                "第 1 集",
                "葬送的芙莉莲",
                Some("http://example.com/cover.jpg"),
                "http://example.com/video.mp4",
            )
            .await
            .unwrap();

        let backup = user_repo.export_backup().await.unwrap();
        assert_eq!(backup.collections.len(), 1);
        assert_eq!(backup.playback_history.len(), 1);
        assert_eq!(backup.collections[0].bangumi_id, 400602);
        assert_eq!(backup.playback_history[0].episode_id, 888);

        // 导入到新的独立空数据库
        let pool2 = open(&std::path::PathBuf::from(":memory:")).await.unwrap();
        let user_repo2 = UserDataRepo::new(pool2.clone());
        let col_repo2 = CollectionRepo::new(pool2.clone());
        let pb_repo2 = PlaybackRepo::new(pool2.clone());

        let stats = user_repo2.import_backup(&backup).await.unwrap();
        assert_eq!(stats.collections_imported, 1);
        assert_eq!(stats.playback_imported, 1);

        let cols = col_repo2.list().await.unwrap();
        assert_eq!(cols.len(), 1);
        assert_eq!(cols[0].name_cn, "葬送的芙莉莲");

        let pbs = pb_repo2.list_recent(10).await.unwrap();
        assert_eq!(pbs.len(), 1);
        assert_eq!(pbs[0].title, "第 1 集");
        assert_eq!(pbs[0].position_seconds, 240.0);
    }

    #[tokio::test]
    async fn test_cache_item_repo_clear_all() {
        let pool = open(&std::path::PathBuf::from(":memory:")).await.unwrap();
        let cache_repo = CacheItemRepo::new(pool);
        cache_repo
            .put("0123456789abcdef", "Test Ep 1", "http://example.com/1.mp4")
            .await
            .unwrap();
        cache_repo
            .put("fedcba9876543210", "Test Ep 2", "http://example.com/2.mp4")
            .await
            .unwrap();
        assert_eq!(cache_repo.list().await.unwrap().len(), 2);

        cache_repo.clear_all().await.unwrap();
        assert_eq!(cache_repo.list().await.unwrap().len(), 0);
    }

    #[tokio::test]
    async fn test_playback_pending_ops() {
        let pool = open(&std::path::PathBuf::from(":memory:")).await.unwrap();
        let pb_repo = PlaybackRepo::new(pool);

        // 初始无挂起任务
        let pending = pb_repo.list_pending_ops().await.unwrap();
        assert!(pending.is_empty());

        // 入账挂起打卡操作
        let op_payload = serde_json::json!({
            "subject_id": 400602,
            "episode_id": 12345
        });
        pb_repo
            .enqueue_pending_op(ani_core::EpisodeId(12345), "mark_watched", &op_payload)
            .await
            .unwrap();

        let pending = pb_repo.list_pending_ops().await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].episode_id, 12345);
        assert_eq!(pending[0].op_kind, "mark_watched");
        assert_eq!(pending[0].attempts, 0);

        // 模拟失败并累加尝试次数
        let id = pending[0].id;
        pb_repo.inc_pending_op_attempts(id).await.unwrap();
        let pending = pb_repo.list_pending_ops().await.unwrap();
        assert_eq!(pending[0].attempts, 1);

        // 模拟同步成功并移除
        pb_repo.remove_pending_op(id).await.unwrap();
        let pending = pb_repo.list_pending_ops().await.unwrap();
        assert!(pending.is_empty());
    }
}
