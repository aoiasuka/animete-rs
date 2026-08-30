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
    Ok(pool)
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
            "SELECT keyword FROM search_history ORDER BY created_at DESC LIMIT ?1",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|(k,)| k).collect())
    }

    pub async fn clear(&self) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM search_history")
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}
