//! ds-mikan —— 蜜柑计划（mikanani.me）RSS 数据源。
//!
//! 实现路径（蓝图 3.2）：feed-rs 解析 RSS → 种子条目 → `Media`。
//! mikan 的经典用法是 `https://mikanani.me/RSS/Search?searchterm=关键词`。

use ani_core::{
    DownloadKind, MatchKind, Media, MediaFetchRequest, MediaKind, MediaMatch, MediaProperties,
    MediaSource, MediaSourceInfo, MediaSourceKind, MediaSourceTier, Resolution, UserError,
};
use async_trait::async_trait;
use reqwest::Client;
use url::Url;

pub const USER_AGENT: &str = "ani-rs/0.1 (https://github.com/ani-rs/ani-rs)";
const BASE: &str = "https://mikanani.me";

#[derive(Debug, Clone)]
pub struct MikanSource {
    http: Client,
    info: MediaSourceInfo,
    token: Option<String>,
}

impl MikanSource {
    pub fn new() -> anyhow::Result<Self> {
        Self::with_token(None)
    }

    pub fn with_token(token: Option<String>) -> anyhow::Result<Self> {
        let http = Client::builder()
            .user_agent(USER_AGENT)
            .timeout(std::time::Duration::from_secs(15))
            .build()?;
        let token = token
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());
        Ok(Self {
            http,
            info: MediaSourceInfo {
                id: "mikan".into(),
                display_name: "蜜柑计划".into(),
                kind: MediaSourceKind::Torrent,
                tier: MediaSourceTier::Medium,
                enabled: true,
            },
            token,
        })
    }

    pub fn set_token(&mut self, token: Option<String>) {
        self.token = token
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());
    }

    pub fn token(&self) -> Option<&str> {
        self.token.as_deref()
    }

    /// 关键词搜索（带 token 时可解锁完整搜索结果）。
    #[allow(dead_code)]
    async fn fetch_rss(&self, searchterm: &str) -> Result<String, UserError> {
        let mut url = format!("{BASE}/RSS/Search?searchterm={}", urlencode(searchterm));
        if let Some(token) = &self.token {
            url.push_str(&format!("&token={}", urlencode(token)));
        }
        self.get_with_retry(&url).await
    }

    /// 按 Bangumi 条目 ID 拉全集 RSS（当前可用的接口，无需登录/字幕组 ID）。
    async fn fetch_rss_by_bangumi(&self, bangumi_id: u32) -> Result<String, UserError> {
        let mut url = format!("{BASE}/RSS/Bangumi?bangumiId={bangumi_id}");
        if let Some(token) = &self.token {
            url.push_str(&format!("&token={}", urlencode(token)));
        }
        self.get_with_retry(&url).await
    }

    /// 拉取当前用户的专属订阅 RSS (/RSS/MyBangumi?token=...)。
    pub async fn fetch_my_bangumi(&self) -> Result<Vec<MediaMatch>, UserError> {
        let Some(token) = &self.token else {
            return Err(UserError::internal(
                "请先在设置中填写蜜柑计划 Token 才能拉取专属订阅",
            ));
        };
        let url = format!("{BASE}/RSS/MyBangumi?token={}", urlencode(token));
        let xml = self.get_with_retry(&url).await?;
        Ok(parse_rss(&xml)
            .into_iter()
            .map(|m| MediaMatch {
                match_kind: MatchKind::Fuzzy,
                media: m,
            })
            .collect())
    }

    /// GET + 传输失败重试（代理/跨境链路瞬断很常见）。
    async fn get_with_retry(&self, url: &str) -> Result<String, UserError> {
        for attempt in 0..2 {
            if attempt > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(600)).await;
            }
            match self.http.get(url).send().await {
                Ok(resp) => {
                    let resp = resp
                        .error_for_status()
                        .map_err(|e| UserError::from(e.without_url()))?;
                    return resp
                        .text()
                        .await
                        .map_err(|e| UserError::from(e.without_url()));
                }
                Err(e) => {
                    if attempt == 1 {
                        return Err(UserError::Network {
                            detail: format!("mikan 请求失败：{}", e.without_url()),
                        });
                    }
                }
            }
        }
        unreachable!("retry loop always returns or errors")
    }
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// 解析 RSS XML（纯函数，fixture 单测入口）。
pub fn parse_rss(xml: &str) -> Vec<Media> {
    let feed = match feed_rs::parser::parse(xml.as_bytes()) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    feed.entries
        .into_iter()
        .map(|e| {
            let title = e
                .title
                .as_ref()
                .map(|t| t.content.clone())
                .unwrap_or_default();
            // mikan RSS 的 enclosure 是种子直链。
            // feed-rs 2.x 把 <enclosure> 归一化进 media[].content[]（url/size），
            // links 里只有条目详情页链接，不能用作下载地址。
            let content = e.media.first().and_then(|m| m.content.first());
            let uri = content
                .and_then(|c| c.url.clone())
                .map(|u| u.to_string())
                .unwrap_or_default();
            let size_bytes = content.and_then(|c| c.size);
            Media {
                media_source_id: "mikan".into(),
                title: title.clone(),
                kind: MediaKind::FullEpisode,
                episode_id: None,
                properties: MediaProperties {
                    resolution: Resolution::guess_from_title(&title),
                    size_bytes,
                    ..Default::default()
                },
                download: DownloadKind::Torrent { uri },
            }
        })
        .collect()
}

#[async_trait]
impl MediaSource for MikanSource {
    fn info(&self) -> &MediaSourceInfo {
        &self.info
    }

    async fn fetch(&self, req: &MediaFetchRequest) -> Result<Vec<MediaMatch>, UserError> {
        // /RSS/Search 匿名接口已废（任何关键词恒空），按 Bangumi 条目 ID 取全集，
        // 集数过滤交给选源引擎；无 ID 时退回关键词搜索兜底
        let xml = match req.subject_id {
            Some(id) => self.fetch_rss_by_bangumi(id).await?,
            None => {
                let kw = req.keywords().first().cloned().unwrap_or_default();
                if kw.is_empty() {
                    return Ok(Vec::new());
                }
                self.fetch_rss(&kw).await?
            }
        };
        Ok(parse_rss(&xml)
            .into_iter()
            .map(|m| MediaMatch {
                match_kind: MatchKind::Fuzzy,
                media: m,
            })
            .collect())
    }
}

/// 把 `BASE` 暴露出来以便测试/重定向。
pub fn base_url() -> Url {
    Url::parse(BASE).expect("static url")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// mikan RSS 的真实结构：条目链接是详情页，下载地址在 <enclosure>。
    const FIXTURE: &str = r#"<rss version="2.0"><channel>
    <item>
        <guid isPermaLink="false">1</guid>
        <link>https://mikanani.me/Home/Episode/abc</link>
        <title>[LoliHouse] 葬送的芙莉莲 - 01 [WebRip 1080p HEVC-10bit AAC][简繁内封]</title>
        <enclosure type="application/x-bittorrent" length="356515840" url="https://mikanani.me/Download/2023-10/abc.torrent"/>
    </item>
    </channel></rss>"#;

    #[test]
    fn enclosure_is_the_download_url() {
        let ms = parse_rss(FIXTURE);
        assert_eq!(ms.len(), 1);
        let m = &ms[0];
        // 回归：不能把详情页链接当下载地址
        let DownloadKind::Torrent { uri } = &m.download else {
            panic!("expected torrent download");
        };
        assert!(uri.ends_with(".torrent"));
        assert_eq!(m.properties.size_bytes, Some(356_515_840));
        assert_eq!(m.properties.resolution.unwrap().height, 1080);
    }

    #[test]
    fn test_token_configuration() {
        let mut src = MikanSource::with_token(Some("test_token_123".into())).unwrap();
        assert_eq!(src.token(), Some("test_token_123"));
        src.set_token(None);
        assert_eq!(src.token(), None);
        src.set_token(Some("   ".into()));
        assert_eq!(src.token(), None);
    }
}
