//! ani-core —— 全项目的"普通话"。
//!
//! 对应 Ani 的 `:datasource:api`：`Media` / `MediaSource` 两个抽象是整个工程的地基。
//! 规则：所有跨前后端类型 derive `Serialize/Deserialize/Clone/Debug`；ID 一律 newtype；
//! 枚举统一 `#[serde(tag = "type")]`；字段只加不改名。

pub mod error;
pub mod media;
pub mod source;

pub use error::UserError;
pub use media::*;
pub use source::*;

use serde::{Deserialize, Serialize};

/// Bangumi 条目 ID。newtype 防混用。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, PartialOrd, Ord)]
pub struct SubjectId(pub u32);

/// 剧集 ID。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, PartialOrd, Ord)]
pub struct EpisodeId(pub u64);

/// 播放进度（对应 Room 的 PlaybackHistoryRecordEntity）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaybackPosition {
    pub episode_id: EpisodeId,
    pub position_seconds: f64,
    pub duration_seconds: Option<f64>,
    pub finished: bool,
    /// unix millis
    pub updated_at: i64,
}
