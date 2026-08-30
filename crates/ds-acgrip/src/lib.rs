//! ds-acgrip —— acg.rip BT 数据源（RSS）。
//!
//! `GET /.xml?term=关键词` 返回 RSS，enclosure 为 .torrent 直链。
//! 与 ds-mikan 共用 feed-rs 解析路径，这里独立成 crate 保持一源一包的纪律。

use ani_core::{
    DownloadKind, MatchKind, Media, MediaFetchRequest, MediaKind, MediaMatch, MediaProperties,
    MediaSource, MediaSourceInfo, MediaSourceKind, MediaSourceTier, Resolution, UserError,
};
use async_trait::async_trait;
use reqwest::Client;

const BASE: &str = "https://acg.rip";
pub const USER_AGENT: &str = "ani-rs/0.1 (https://github.com/ani-rs/ani-rs)";

#[derive(Debug, Clone)]
pub struct AcgRipSource {
    http: Client,
    info: MediaSourceInfo,
}

impl AcgRipSource {
    pub fn new() -> anyhow::Result<Self> {
        let http = Client::builder()
            .user_agent(USER_AGENT)
            .timeout(std::time::Duration::from_secs(15))
            .build()?;
        Ok(Self {
            http,
            info: MediaSourceInfo {
                id: "acgrip".into(),
                display_name: "acg.rip".into(),
                kind: MediaSourceKind::Torrent,
                tier: MediaSourceTier::Medium,
                enabled: true,
            },
        })
    }

    async fn fetch_rss(&self, term: &str) -> Result<String, UserError> {
        let url = format!("{}/.xml?term={}", BASE, urlencode(term));
        Ok(self
            .http
            .get(&url)
            .send()
            .await?
            .error_for_status()?
            .text()
            .await?)
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

/// 解析 acg.rip RSS（纯函数，fixture 单测入口）。
///
/// 真实结构（2026-08 实证）：`<enclosure url=.torrent>` 无 length；
/// 大小在 `<media:content fileSize=>`（feed-rs 映射为 content.size）。
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
            let contents: Vec<_> = e.media.iter().flat_map(|m| m.content.iter()).collect();
            let uri = contents
                .iter()
                .find_map(|c| c.url.clone())
                .map(|u| u.to_string())
                .unwrap_or_default();
            let size_bytes = contents.iter().find_map(|c| c.size);
            let resolution = Resolution::guess_from_title(&title);
            Media {
                media_source_id: "acgrip".into(),
                title,
                kind: MediaKind::FullEpisode,
                episode_id: None,
                properties: MediaProperties {
                    resolution,
                    size_bytes,
                    ..Default::default()
                },
                download: DownloadKind::Torrent { uri },
            }
        })
        .collect()
}

#[async_trait]
impl MediaSource for AcgRipSource {
    fn info(&self) -> &MediaSourceInfo {
        &self.info
    }

    async fn fetch(&self, req: &MediaFetchRequest) -> Result<Vec<MediaMatch>, UserError> {
        let mut out = Vec::new();
        for kw in req.keywords().iter().take(2) {
            // 单个关键词失败不拖垮整体（还有别名/其它源）
            let xml = match self.fetch_rss(kw).await {
                Ok(x) => x,
                Err(e) => {
                    tracing::warn!("acgrip fetch {kw:?} failed: {e}");
                    continue;
                }
            };
            for m in parse_rss(&xml) {
                out.push(MediaMatch {
                    match_kind: MatchKind::Fuzzy,
                    media: m,
                });
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// acg.rip RSS 的真实结构（2026-08 实证）：enclosure 只有 url 没有 length，
    /// 大小在 <media:content fileSize>；<link> 是详情页。
    const FIXTURE: &str = r#"<rss version="2.0" xmlns:torrent="http://xmlns.ezrss.it/0.1/" xmlns:media="http://search.yahoo.com/mrss/"><channel>
    <item>
        <title>[Group] Show - 01 [1080p] [Bilibili WEB-DL] AAC H.264</title>
        <description>搬运</description>
        <pubDate>Fri, 22 Sep 2023 13:45:02 +0000</pubDate>
        <link>https://acg.rip/item/67890</link>
        <guid>https://acg.rip/item/67890</guid>
        <enclosure url="https://acg.rip/t/67890.torrent" type="application/x-bittorrent"/>
        <torrent:contentLength>734003200</torrent:contentLength>
        <media:content url="https://acg.rip/t/67890.torrent" fileSize="734003200"/>
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
        assert_eq!(uri, "https://acg.rip/t/67890.torrent");
        assert_eq!(m.properties.size_bytes, Some(734_003_200));
    }
}
