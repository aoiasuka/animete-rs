//! 数据源骨架（对应 `datasource:api`，全项目的脊柱）。
//! 一个数据源 = 一个实现 [`MediaSource`] 的插件；各 `ds-*` crate 只依赖本 crate。

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use smol_str::SmolStr;
use std::sync::Arc;

use crate::error::UserError;
use crate::media::Media;

/// 源分级：自动选源排序的打底分（对应 MediaSourceTier）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum MediaSourceTier {
    /// 媒体服务器（Jellyfin 等），最可靠
    High,
    /// 知名字幕组 BT 源
    Medium,
    /// 一般 Web/BT 源
    Low,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaSourceKind {
    Torrent,
    Web,
    Local,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaSourceInfo {
    pub id: SmolStr,
    pub display_name: String,
    pub kind: MediaSourceKind,
    pub tier: MediaSourceTier,
    pub enabled: bool,
}

/// 选源请求：条目名 / 别名 / 剧集序号 / 季节 / 年份。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MediaFetchRequest {
    /// 条目中文名（中文优先）
    pub subject_name: String,
    /// 日文原名 + 别名，全部参与检索
    pub aliases: Vec<String>,
    /// Bangumi 条目 ID（mikan 的 /RSS/Bangumi 按它取全集 RSS；已知时务必传入）
    #[serde(default)]
    pub subject_id: Option<u32>,
    /// 剧集序号（Bangumi ep 值）
    pub episode: Option<f32>,
    /// 季度（S1/S2），1 表示第一季
    pub season: Option<u32>,
    /// 播放年份
    pub year: Option<u32>,
    /// 剧集标题（"第二集 铁球" 之类，拼进关键词）
    pub episode_title: Option<String>,
}

impl MediaFetchRequest {
    pub fn keywords(&self) -> Vec<String> {
        let mut v = vec![self.subject_name.clone()];
        v.extend(self.aliases.iter().cloned());
        v.retain(|s| !s.trim().is_empty());
        v
    }
}

/// 匹配度（对应 Ani 的 MatchKind）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchKind {
    Exact,
    Fuzzy,
    Mismatch,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaMatch {
    pub media: Media,
    pub match_kind: MatchKind,
}

/// 一个数据源 = 一个实现此 trait 的插件。
#[async_trait]
pub trait MediaSource: Send + Sync {
    fn info(&self) -> &MediaSourceInfo;

    /// 向该源检索候选视频。实现应自行处理超时/重试/缓存，
    /// 并把所有失败收敛为 [`UserError`]（验证码场景返回 `CaptchaRequired`）。
    async fn fetch(&self, req: &MediaFetchRequest) -> Result<Vec<MediaMatch>, UserError>;
}

/// 选源管理器：注册/启停（对应 Ani 的 MediaSourceInstanceManager）。
/// 插件注册用最朴素的方式：装配时按配置手动加入，动态启停用配置控制而非 dylib。
#[derive(Default)]
pub struct MediaSourceRegistry {
    sources: std::sync::RwLock<Vec<Arc<dyn MediaSource>>>,
    /// 运行时被用户停用的源（设置界面开关，写入 preferences）
    disabled: std::sync::RwLock<std::collections::HashSet<SmolStr>>,
}

impl MediaSourceRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, s: Arc<dyn MediaSource>) {
        self.sources.write().unwrap().push(s);
    }

    /// 运行时替换同名源（如 Jellyfin 配置修改后重建）：不存在时等同 register。
    pub fn replace(&self, s: Arc<dyn MediaSource>) {
        let mut list = self.sources.write().unwrap();
        let id = s.info().id.clone();
        list.retain(|x| x.info().id != id);
        list.push(s);
    }

    /// 运行时注册（如配置了 Jellyfin 服务器后从设置界面加入）。
    pub fn register_runtime(self: &std::sync::Arc<Self>, s: Arc<dyn MediaSource>) {
        self.register(s);
    }

    pub fn sources(&self) -> Vec<Arc<dyn MediaSource>> {
        self.sources.read().unwrap().clone()
    }

    /// 运行时启停某源（设置界面调用）。
    pub fn set_enabled(&self, id: &str, enabled: bool) {
        let mut d = self.disabled.write().unwrap();
        if enabled {
            d.remove(id);
        } else {
            d.insert(id.into());
        }
    }

    /// 全部源的信息（含运行时启停状态），供设置界面展示。
    pub fn list_info(&self) -> Vec<MediaSourceInfo> {
        let d = self.disabled.read().unwrap();
        self.sources
            .read()
            .unwrap()
            .iter()
            .map(|s| {
                let mut info = s.info().clone();
                info.enabled = info.enabled && !d.contains(&info.id);
                info
            })
            .collect()
    }

    pub fn enabled(&self) -> Vec<Arc<dyn MediaSource>> {
        let d = self.disabled.read().unwrap();
        self.sources
            .read()
            .unwrap()
            .iter()
            .filter(|s| s.info().enabled && !d.contains(&s.info().id))
            .cloned()
            .collect()
    }

    /// 向所有启用源并发请求，聚合候选（对应 domain/media/fetch）。
    /// 单源失败不拖垮整体：失败源记日志后跳过。
    pub async fn fetch_all(
        &self,
        req: &MediaFetchRequest,
    ) -> Vec<(SmolStr, Result<Vec<MediaMatch>, UserError>)> {
        let futs = self
            .enabled()
            .into_iter()
            .map(|s| async move { (s.info().id.clone(), s.fetch(req).await) })
            .collect::<Vec<_>>();
        futures::future::join_all(futs).await
    }
}
