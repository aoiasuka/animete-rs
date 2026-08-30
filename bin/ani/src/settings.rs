//! Preferences（对应蓝图 8.1，DataStore 的等价物）：
//! 单文件 JSON + `version` 字段（链式迁移预留）+ "临时文件 + rename" 原子写。
//! 设置变更立即生效：选源偏好/数据源启停直接影响下一次检索。

use ani_danmaku::DanmakuFilter;
use ani_domain::MediaPreference;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const SETTINGS_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct TorrentSettings {
    /// 下载目录，空 = 默认 %APPDATA%/ani-rs/downloads
    pub download_dir: String,
    /// 做种开关（对应 Ani 的做种策略：默认开启回馈 swarm）
    pub seeding: bool,
    /// 监听端口（0 = 系统分配）
    pub listen_port: u16,
    /// mpv.exe 路径，空 = 自动探测（PATH + 常见安装位置）；
    /// BT 渐进播放用它，找不到时退回系统默认播放器
    pub mpv_path: String,
    /// 渐进播放起播缓冲（MB）：视频头部下载到该量即拉起播放器
    pub stream_head_mb: u32,
    /// 渐进播放等待元数据+头部的总超时（分钟）
    pub stream_timeout_min: u32,
}

impl Default for TorrentSettings {
    fn default() -> Self {
        Self {
            download_dir: String::new(),
            seeding: true,
            listen_port: 4242,
            mpv_path: String::new(),
            stream_head_mb: 8,
            stream_timeout_min: 15,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct JellyfinSettings {
    pub server_url: String,
    pub username: String,
    pub password: String,
    pub api_key: String,
}

impl JellyfinSettings {
    pub fn is_configured(&self) -> bool {
        !self.server_url.trim().is_empty()
            && (!self.api_key.trim().is_empty() || !self.username.trim().is_empty())
    }

    pub fn to_config(&self) -> ds_jellyfin::JellyfinConfig {
        ds_jellyfin::JellyfinConfig {
            server_url: self.server_url.clone(),
            username: self.username.clone(),
            password: self.password.clone(),
            api_key: self.api_key.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SourceState {
    pub id: String,
    pub enabled: bool,
    /// 用户覆盖的源优先级："high" | "medium" | "low"（参与选源评分，None = 用内置分级）
    pub tier: Option<String>,
}

impl Default for SourceState {
    fn default() -> Self {
        Self {
            id: String::new(),
            enabled: true,
            tier: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DanmakuSourceSettings {
    /// 弹幕总开关（播放器内显示弹幕）
    pub enabled: bool,
    /// dandanplay 开放平台 AppId/AppSecret（免费申请）
    pub app_id: String,
    pub app_secret: String,
}

/// Bangumi 账号（OAuth，用于看完自动打卡收藏/进度）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BangumiAuthSettings {
    /// bgm.tv 开发者平台创建应用的 ClientID/Secret
    pub client_id: String,
    pub client_secret: String,
    /// 创建应用时登记的回调地址（未登记则留空，授权页直接显示授权码）
    pub redirect_uri: String,
    pub access_token: String,
    pub refresh_token: String,
    /// token 绝对过期时间（unix 毫秒）
    pub expires_at_ms: i64,
    pub nickname: String,
}

impl BangumiAuthSettings {
    pub fn has_credentials(&self) -> bool {
        !self.client_id.trim().is_empty() && !self.client_secret.trim().is_empty()
    }
    pub fn is_logged_in(&self) -> bool {
        !self.access_token.is_empty()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SettingsData {
    pub version: u32,
    /// 自动选源偏好（对应 MediaSelectorSubtitlePreferences）
    pub selector: MediaPreference,
    /// 弹幕屏蔽（对应 danmaku-ui-config）
    pub danmaku: DanmakuFilter,
    /// 弹幕源（dandanplay 开放 API 凭据）
    pub danmaku_source: DanmakuSourceSettings,
    pub torrent: TorrentSettings,
    /// Jellyfin 媒体服务器（配置后作为高分片源出现，支持在线播放）
    pub jellyfin: JellyfinSettings,
    /// Bangumi 账号（看完自动打卡收藏/进度）
    pub bangumi: BangumiAuthSettings,
    /// 数据源启停
    pub sources: Vec<SourceState>,
}

impl Default for SettingsData {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            selector: MediaPreference::default(),
            danmaku: DanmakuFilter::default(),
            danmaku_source: DanmakuSourceSettings::default(),
            torrent: TorrentSettings::default(),
            jellyfin: JellyfinSettings::default(),
            bangumi: BangumiAuthSettings::default(),
            sources: Vec::new(),
        }
    }
}

pub fn settings_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("ani-rs")
        .join("settings.json")
}

impl SettingsData {
    /// 读取失败/文件不存在时返回默认值（设置损坏不应阻止启动）。
    pub fn load() -> Self {
        match std::fs::read_to_string(settings_path()) {
            Ok(text) => match serde_json::from_str::<SettingsData>(&text) {
                Ok(mut s) => {
                    migrate(&mut s);
                    s
                }
                Err(e) => {
                    tracing::warn!("settings parse failed, using defaults: {e}");
                    // 损坏文件留档，避免下一次保存把它无痕覆盖（密码/偏好全丢）
                    let _ = std::fs::rename(
                        settings_path(),
                        settings_path().with_extension("json.bad"),
                    );
                    Self::default()
                }
            },
            Err(_) => Self::default(),
        }
    }

    /// 原子写：先写 .tmp 再 rename。
    pub fn save(&self) -> anyhow::Result<()> {
        let path = settings_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(self)?)?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    /// 某数据源的启停状态（未记录过的源默认启用）。
    pub fn source_enabled(&self, id: &str) -> bool {
        self.sources
            .iter()
            .find(|s| s.id == id)
            .map(|s| s.enabled)
            .unwrap_or(true)
    }

    /// 记录数据源启停状态。
    #[allow(dead_code)] // CLI/后续里程碑复用
    pub fn set_source_enabled(&mut self, id: &str, enabled: bool) {
        if let Some(s) = self.sources.iter_mut().find(|s| s.id == id) {
            s.enabled = enabled;
        } else {
            self.sources.push(SourceState {
                id: id.into(),
                enabled,
                tier: None,
            });
        }
    }
}

/// 版本迁移：字段只加不改名，旧文件缺字段由 `#[serde(default)]` 兜底。
fn migrate(s: &mut SettingsData) {
    // v0(无版本号)/v1 → 当前：暂无破坏性变更
    if s.version < SETTINGS_VERSION {
        s.version = SETTINGS_VERSION;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_source_state() {
        let mut s = SettingsData::default();
        s.selector.subtitle_group = Some("LoliHouse".into());
        s.selector.blacklist_keywords = ["预告".into(), "PV".into()].into_iter().collect();
        s.torrent.listen_port = 5555;
        s.set_source_enabled("dmhy", false);
        s.set_source_enabled("dmhy", true);
        s.set_source_enabled("mikan", false);

        let json = serde_json::to_string(&s).unwrap();
        let back: SettingsData = serde_json::from_str(&json).unwrap();
        assert_eq!(back.selector.subtitle_group.as_deref(), Some("LoliHouse"));
        assert_eq!(back.torrent.listen_port, 5555);
        assert!(back.source_enabled("dmhy"));
        assert!(!back.source_enabled("mikan"));
        assert!(back.source_enabled("unknown")); // 未记录的源默认启用
    }

    #[test]
    fn tolerant_parse() {
        // 旧文件缺字段也能读（serde default 兜底）
        let s: SettingsData = serde_json::from_str("{}").unwrap();
        assert_eq!(s.version, SETTINGS_VERSION);
        assert!(s.torrent.seeding);
    }
}
