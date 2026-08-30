//! ds-nyaa —— nyaa.si BT 数据源（RSS）。
//!
//! `GET /?page=rss&q=关键词` 返回 RSS，enclosure 为 .torrent 直链。

use ani_core::{
    DownloadKind, MatchKind, Media, MediaFetchRequest, MediaKind, MediaMatch, MediaProperties,
    MediaSource, MediaSourceInfo, MediaSourceKind, MediaSourceTier, Resolution, UserError,
};
use async_trait::async_trait;
use reqwest::Client;

const BASE: &str = "https://nyaa.si";
pub const USER_AGENT: &str = "ani-rs/0.1 (https://github.com/ani-rs/ani-rs)";

#[derive(Debug, Clone)]
pub struct NyaaSource {
    http: Client,
    info: MediaSourceInfo,
}

impl NyaaSource {
    pub fn new() -> anyhow::Result<Self> {
        let http = Client::builder()
            .user_agent(USER_AGENT)
            .timeout(std::time::Duration::from_secs(15))
            .build()?;
        Ok(Self {
            http,
            info: MediaSourceInfo {
                id: "nyaa".into(),
                display_name: "nyaa.si".into(),
                kind: MediaSourceKind::Torrent,
                tier: MediaSourceTier::Low,
                enabled: true,
            },
        })
    }

    async fn fetch_rss(&self, q: &str) -> Result<String, UserError> {
        let url = format!("{}/?page=rss&q={}", BASE, urlencode(q));
        // 代理/跨境链路瞬断很常见：传输层失败间隔 600ms 重试一次
        for attempt in 0..2 {
            if attempt > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(600)).await;
            }
            match self.http.get(&url).send().await {
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
                        // 不带 URL：长查询会把错误横幅刷成三行
                        return Err(UserError::Network {
                            detail: format!(
                                "nyaa.si 连接失败：{}（站点可能被墙或代理不稳，可在设置中停用该源）",
                                e.without_url()
                            ),
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

/// 解析 nyaa RSS（纯函数，fixture 单测入口）。
///
/// nyaa RSS 的真实结构（2026-08 实证，与 mikan/acgrip 不同）：
/// - `<link>` 就是 .torrent 下载直链（详情页在 `<guid>`）
/// - 没有 `<enclosure>`；大小写在 `<nyaa:size>`（feed-rs 2.x 丢弃未知命名空间），
///   但会出现在 `<description>` CDATA 里（"#id | 683.8 MiB | 分类 | hash"）
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
            // 个别镜像带 enclosure；nyaa 本站没有，回落 links[0]（.torrent 直链）
            let content = e.media.first().and_then(|m| m.content.first());
            let uri = content
                .and_then(|c| c.url.clone())
                .map(|u| u.to_string())
                .or_else(|| e.links.first().map(|l| l.href.clone()))
                .unwrap_or_default();
            let size_bytes = content.and_then(|c| c.size).or_else(|| {
                size_from_text(e.summary.as_ref().map(|s| s.content.as_str()).unwrap_or(""))
            });
            let resolution = Resolution::guess_from_title(&title);
            Media {
                media_source_id: "nyaa".into(),
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

/// 从描述文本的 "| 683.8 MiB |" 段解析大小（nyaa 用 IEC 单位）。
fn size_from_text(desc: &str) -> Option<u64> {
    for seg in desc.split('|') {
        let Some((num, unit)) = seg.trim().split_once(' ') else {
            continue;
        };
        let mult = match unit.trim().to_ascii_lowercase().as_str() {
            "kib" => 1024.0,
            "mib" => 1024.0 * 1024.0,
            "gib" => 1024.0 * 1024.0 * 1024.0,
            "tib" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
            _ => continue,
        };
        return num.trim().parse::<f64>().ok().map(|n| (n * mult) as u64);
    }
    None
}

#[async_trait]
impl MediaSource for NyaaSource {
    fn info(&self) -> &MediaSourceInfo {
        &self.info
    }

    async fn fetch(&self, req: &MediaFetchRequest) -> Result<Vec<MediaMatch>, UserError> {
        let mut out = Vec::new();
        // nyaa 是英文/罗马字站：条目发布名以日文原名为主。
        // 中文名检索必然 0 结果，优先用别名（Bangumi 原名），无别名才回落中文名
        let kw = req
            .aliases
            .iter()
            .map(|a| a.trim())
            .find(|a| !a.is_empty())
            .unwrap_or(req.subject_name.trim());
        if kw.is_empty() {
            return Ok(out);
        }
        let xml = self.fetch_rss(kw).await?;
        for m in parse_rss(&xml) {
            out.push(MediaMatch {
                match_kind: MatchKind::Fuzzy,
                media: m,
            });
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// nyaa RSS 的真实结构（2026-08 实证）：<link> 是 .torrent 直链，
    /// 无 <enclosure>，大小在 <nyaa:size> 与 <description> 文本里。
    const FIXTURE: &str = r#"<rss xmlns:nyaa="https://nyaa.si/xmlns/nyaa" version="2.0"><channel>
    <item>
        <title>[SubsPlease] Sousou no Frieren (01) [1080p] [mass]</title>
        <link>https://nyaa.si/download/12345.torrent</link>
        <guid isPermaLink="true">https://nyaa.si/view/12345</guid>
        <pubDate>Fri, 22 Sep 2023 13:45:02 +0000</pubDate>
        <nyaa:infoHash>15e9e6cec7b0ca597f4969924b88ef783bc2a7ae</nyaa:infoHash>
        <nyaa:size>1.2 GiB</nyaa:size>
        <description><![CDATA[<a href="https://nyaa.si/view/12345">#12345</a> | 1.2 GiB | Anime - English-translated | 15e9e6ce]]></description>
    </item>
    </channel></rss>"#;

    #[test]
    fn link_is_the_download_url_and_size_parsed() {
        let ms = parse_rss(FIXTURE);
        assert_eq!(ms.len(), 1);
        let m = &ms[0];
        // nyaa 的 <link> 本身就是下载直链（详情页在 guid）
        let DownloadKind::Torrent { uri } = &m.download else {
            panic!("expected torrent download");
        };
        assert_eq!(uri, "https://nyaa.si/download/12345.torrent");
        // 大小从 description 的 "| 1.2 GiB |" 段解析（1.2 * 2^30）
        assert_eq!(m.properties.size_bytes, Some(1_288_490_188));
        assert_eq!(m.properties.resolution.unwrap().height, 1080);
    }
}
