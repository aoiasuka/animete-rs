//! ds-jellyfin —— Jellyfin/Emby 媒体服务器数据源（对应 :datasource:jellyfin）。
//!
//! 在线播放的关键源：条目直接产出 HTTP 直链（HLS master.m3u8 / 原始容器），
//! 交给 GUI 内置播放器（hls.js）播放。
//!
//! 认证：`POST /Users/AuthenticateByName`（用户名+密码），返回 AccessToken；
//! 后续请求带 `X-Emby-Token` 头。也支持直接填 API Key（跳过登录）。

use ani_core::{
    DownloadKind, EpisodeId, MatchKind, Media, MediaFetchRequest, MediaKind, MediaMatch,
    MediaProperties, MediaSource, MediaSourceInfo, MediaSourceKind, MediaSourceTier, UserError,
};
use async_trait::async_trait;
use reqwest::Client;
use serde::Deserialize;
use url::Url;

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct JellyfinConfig {
    /// 服务器地址，如 http://192.168.1.10:8096
    pub server_url: String,
    pub username: String,
    pub password: String,
    /// 直接填 API Key 时可留空用户名/密码
    pub api_key: String,
}

impl JellyfinConfig {
    pub fn is_configured(&self) -> bool {
        !self.server_url.trim().is_empty()
            && (!self.api_key.trim().is_empty() || !self.username.trim().is_empty())
    }
}

#[derive(Debug, Clone)]
pub struct JellyfinSource {
    http: Client,
    server: Url,
    info: MediaSourceInfo,
    token: String,
}

#[derive(Debug, thiserror::Error)]
pub enum JellyfinError {
    #[error("jellyfin auth failed: {0}")]
    Auth(String),
    #[error("jellyfin request failed: {0}")]
    Request(String),
}

impl From<JellyfinError> for UserError {
    fn from(e: JellyfinError) -> Self {
        match e {
            JellyfinError::Auth(_) => UserError::SourceBlocked {
                source_name: "jellyfin".into(),
            },
            JellyfinError::Request(d) => UserError::Network { detail: d },
        }
    }
}

const AUTH_HEADER: &str =
    r#"MediaBrowser Client="ani-rs", Device="ani-rs-desktop", DeviceId="ani-rs-1", Version="0.1""#;

impl JellyfinSource {
    /// 用配置连接并登录。失败返回具体错误（设置界面用于提示）。
    pub async fn connect(cfg: &JellyfinConfig) -> Result<Self, JellyfinError> {
        let mut server = Url::parse(cfg.server_url.trim().trim_end_matches('/'))
            .map_err(|e| JellyfinError::Request(format!("bad server url: {e}")))?;
        // 反向代理子路径部署（如 http://host/jellyfin）：Url::join 按 RFC 3986 会
        // 替换掉最后一段，base 必须以 / 结尾才能保住前缀
        if !server.path().ends_with('/') {
            let p = format!("{}/", server.path());
            server.set_path(&p);
        }
        let http = Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|e| JellyfinError::Request(e.to_string()))?;

        let token = if !cfg.api_key.trim().is_empty() {
            cfg.api_key.trim().to_string()
        } else {
            #[derive(Deserialize)]
            struct AuthResp {
                #[serde(rename = "AccessToken")]
                access_token: String,
            }
            let resp: AuthResp = http
                .post(server.join("Users/AuthenticateByName").unwrap())
                .header("X-Emby-Authorization", AUTH_HEADER)
                .json(&serde_json::json!({ "Username": cfg.username, "Pw": cfg.password }))
                .send()
                .await
                .map_err(|e| JellyfinError::Request(e.to_string()))?
                .error_for_status()
                .map_err(|e| JellyfinError::Auth(e.to_string()))?
                .json()
                .await
                .map_err(|e| JellyfinError::Auth(format!("bad response: {e}")))?;
            resp.access_token
        };

        Ok(Self {
            http,
            server,
            token,
            info: MediaSourceInfo {
                id: "jellyfin".into(),
                display_name: "Jellyfin".into(),
                kind: MediaSourceKind::Web,
                tier: MediaSourceTier::High,
                enabled: true,
            },
        })
    }

    /// 生成可播的直链（HLS 转封装；直接 .ts/.mkv 容器部分客户端不支持，统一走 HLS）。
    pub fn stream_url(&self, item_id: &str) -> Url {
        let mut u = self
            .server
            .join(&format!("Videos/{item_id}/master.m3u8"))
            .expect("valid join");
        // query_pairs_mut 正确编码 token（含 &/空格/+ 时 set_query 会损坏查询串）
        u.query_pairs_mut().append_pair("api_key", &self.token);
        u
    }

    async fn search_series(&self, kw: &str) -> Result<Vec<JfItem>, UserError> {
        let mut u = self.server.join("Items").unwrap();
        u.query_pairs_mut()
            .append_pair("searchTerm", kw)
            .append_pair("Recursive", "true")
            .append_pair("IncludeItemTypes", "Series")
            .append_pair("Limit", "8")
            .append_pair("api_key", &self.token);
        #[derive(Deserialize)]
        struct Resp {
            #[serde(rename = "Items", default)]
            items: Vec<JfItem>,
        }
        let r: Resp = self
            .http
            .get(u)
            .header("X-Emby-Token", &self.token)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok(r.items)
    }

    async fn episodes_of(&self, series_id: &str) -> Result<Vec<JfItem>, UserError> {
        let mut u = self
            .server
            .join(&format!("Shows/{series_id}/Episodes"))
            .unwrap();
        u.query_pairs_mut().append_pair("api_key", &self.token);
        #[derive(Deserialize)]
        struct Resp {
            #[serde(rename = "Items", default)]
            items: Vec<JfItem>,
        }
        let r: Resp = self
            .http
            .get(u)
            .header("X-Emby-Token", &self.token)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok(r.items)
    }
}

#[derive(Deserialize, Debug, Clone)]
struct JfItem {
    #[serde(rename = "Id")]
    id: String,
    #[serde(rename = "Name", default)]
    name: String,
    #[serde(rename = "SeriesName", default)]
    series_name: String,
    #[serde(rename = "ParentIndexNumber", default)]
    season: Option<u32>,
    #[serde(rename = "IndexNumber", default)]
    episode: Option<u32>,
}

#[async_trait]
impl MediaSource for JellyfinSource {
    fn info(&self) -> &MediaSourceInfo {
        &self.info
    }

    /// 搜索媒体库里的剧集，产出每集的 HLS 直链（在线播放）。
    async fn fetch(&self, req: &MediaFetchRequest) -> Result<Vec<MediaMatch>, UserError> {
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for kw in req.keywords().iter().take(2) {
            for series in self.search_series(kw).await? {
                let eps = match self.episodes_of(&series.id).await {
                    Ok(e) => e,
                    Err(e) => {
                        tracing::warn!("jellyfin episodes of {} failed: {e}", series.name);
                        continue;
                    }
                };
                let want_ep = req.episode;
                for ep in eps {
                    // 同一集被多个关键词命中时只保留一份
                    if !seen.insert(ep.id.clone()) {
                        continue;
                    }
                    if let Some(want) = want_ep {
                        // 有明确集号请求时必须命中：缺 IndexNumber 的是 special/OVA，
                        // 不能当作 Exact 候选混进自动选源
                        match ep.episode {
                            Some(n) if (n as f32 - want).abs() <= 0.01 => {}
                            _ => continue,
                        }
                        // 季号请求存在时同时校验季
                        if let Some(want_s) = req.season {
                            match ep.season {
                                Some(s) if s == want_s => {}
                                _ => continue,
                            }
                        }
                    }
                    let title = match (ep.season, ep.episode) {
                        (Some(s), Some(e)) => {
                            format!("{} S{s:02}E{e:02} {}", ep.series_name, ep.name)
                        }
                        _ => format!("{} - {}", ep.series_name, ep.name),
                    };
                    out.push(MediaMatch {
                        match_kind: if want_ep.is_some() {
                            MatchKind::Exact
                        } else {
                            MatchKind::Fuzzy
                        },
                        media: Media {
                            media_source_id: "jellyfin".into(),
                            title,
                            kind: MediaKind::FullEpisode,
                            episode_id: ep.episode.map(|n| EpisodeId(n as u64)),
                            properties: MediaProperties::default(),
                            download: DownloadKind::Http {
                                url: self.stream_url(&ep.id),
                                headers: Vec::new(),
                            },
                        },
                    });
                }
            }
        }
        Ok(out)
    }
}
