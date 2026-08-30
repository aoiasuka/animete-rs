//! 核心领域模型：Subject / Episode / Media / Candidate。
//! 数据字典见蓝图第 6 章；SQL 行类型与领域模型分离，由 Repository 互转。

use serde::{Deserialize, Serialize};
use smol_str::SmolStr;
use url::Url;

use crate::{EpisodeId, SubjectId};

/// Bangumi 剧集类型（v0 API 的 type 字段）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EpisodeKind {
    /// 正片（type=0）
    Main,
    /// SP (1)
    Special,
    /// OP (2)
    Opening,
    /// ED (3)
    Ending,
    /// 预告/广告 (4)
    Preview,
    /// (6)
    Other,
}

impl EpisodeKind {
    pub fn from_bangumi_type(t: u8) -> Self {
        match t {
            1 => Self::Special,
            2 => Self::Opening,
            3 => Self::Ending,
            4 => Self::Preview,
            6 => Self::Other,
            _ => Self::Main,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubjectSummary {
    pub id: SubjectId,
    /// 中文优先，缺省回落日文原名（Ani 同款策略）
    pub display_title: String,
    pub original_title: String,
    /// ISO-8601 日期
    pub air_date: Option<String>,
    /// 封面 URL
    pub cover_url: Option<Url>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Episode {
    pub id: EpisodeId,
    pub subject_id: SubjectId,
    pub ep: f32,
    pub kind: EpisodeKind,
    pub display_title: String,
}

/// 一个具体视频条目的类别。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaKind {
    FullEpisode,
    Preview,
    OpEd,
    Other,
}

/// 分辨率（自动选源里做 closeness 比较）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Resolution {
    pub width: u32,
    pub height: u32,
}

impl Resolution {
    /// 从标题里的 "1080P"/"720p" 等猜测分辨率（数据源解析的辅助）。
    pub fn guess_from_title(title: &str) -> Option<Self> {
        let t = title.to_ascii_lowercase();
        let h = if t.contains("4320") {
            4320
        } else if t.contains("2160") || t.contains("4k") {
            2160
        } else if t.contains("1080") {
            1080
        } else if t.contains("720") {
            720
        } else if t.contains("480") {
            480
        } else if t.contains("360") {
            360
        } else {
            return None;
        };
        Some(Self {
            width: h * 16 / 9,
            height: h,
        })
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MediaProperties {
    pub resolution: Option<Resolution>,
    /// "chi", "jpn", "chs", "cht" …
    pub subtitle_language: Option<String>,
    /// 字幕组（LoliHouse / NC-Raws …）
    pub subtitle_group: Option<String>,
    pub audio_language: Option<String>,
    pub size_bytes: Option<u64>,
    pub duration_secs: Option<f64>,
    /// ISO-8601
    pub release_date: Option<String>,
}

/// 下载方式（对应 Ani 的 Media.mediaLocator 三态）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DownloadKind {
    Torrent {
        /// magnet: 链接，或指向 .torrent 的 URL
        uri: String,
    },
    Http {
        url: Url,
        #[serde(default)]
        headers: Vec<(String, String)>,
    },
    LocalFile {
        path: String,
    },
}

/// 一个具体视频条目（对应 Ani 的 `Media`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Media {
    /// 来源数据源 ID，如 "bangumi" / "dmhy"
    pub media_source_id: SmolStr,
    pub title: String,
    pub kind: MediaKind,
    /// 所属剧集（Bangumi EpisodeId），未知为 None
    pub episode_id: Option<EpisodeId>,
    pub properties: MediaProperties,
    pub download: DownloadKind,
}

/// 排除原因（对应 Ani 的 MediaExclusionReason）：每个候选都带"为什么被排除"。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "reason", rename_all = "snake_case")]
pub enum ExcludeReason {
    /// 之前试过且播放失败
    PreviouslyFailed,
    /// 用户拉黑了该字幕组/关键词
    Blacklisted,
    /// 分辨率低于用户下限
    ResolutionTooLow,
    /// 剧集序号不匹配
    EpisodeMismatch,
}

/// 选源候选（对应 Ani 的 MaybeExcludedMedia）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Candidate {
    Available { media: Media, score: f32 },
    Excluded { media: Media, reason: ExcludeReason },
}

impl Candidate {
    pub fn media(&self) -> &Media {
        match self {
            Candidate::Available { media, .. } | Candidate::Excluded { media, .. } => media,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolution_guess() {
        assert_eq!(
            Resolution::guess_from_title("[LoliHouse] Frieren 1080p"),
            Some(Resolution {
                width: 1920,
                height: 1080
            })
        );
        assert_eq!(Resolution::guess_from_title("nothing here"), None);
    }
}
