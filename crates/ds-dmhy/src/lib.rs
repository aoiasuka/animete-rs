//! ds-dmhy —— 动漫花园（share.dmhy.org）BT 数据源。
//!
//! 实现路径（蓝图 3.2 / 7.3）：scraper 解析列表页 CSS 选择器 → 种子条目 → `Media`。
//! 工程要点：镜像列表 + UA/超时/重试；解析函数纯函数化，配 HTML fixture 单测，
//! 站点改版时测试先红。

use ani_core::{
    Candidate, DownloadKind, MatchKind, Media, MediaFetchRequest, MediaKind, MediaMatch,
    MediaProperties, MediaSource, MediaSourceInfo, MediaSourceKind, MediaSourceTier, UserError,
};
use async_trait::async_trait;
use reqwest::Client;
use scraper::{Html, Selector};

pub const USER_AGENT: &str = "ani-rs/0.1 (https://github.com/ani-rs/ani-rs)";

const MIRRORS: &[&str] = &["https://share.dmhy.org", "https://dmhy.org"];

#[derive(Debug, Clone)]
pub struct DmhySource {
    http: Client,
    info: MediaSourceInfo,
}

impl DmhySource {
    pub fn new() -> anyhow::Result<Self> {
        let http = Client::builder()
            .user_agent(USER_AGENT)
            .timeout(std::time::Duration::from_secs(15))
            .build()?;
        Ok(Self {
            http,
            info: MediaSourceInfo {
                id: "dmhy".into(),
                display_name: "动漫花园".into(),
                kind: MediaSourceKind::Torrent,
                tier: MediaSourceTier::Medium,
                enabled: true,
            },
        })
    }

    /// 拉取列表页 HTML（镜像轮询）。
    async fn fetch_page(&self, keywords: &str) -> Result<String, UserError> {
        let mut last = UserError::NotFound;
        for mirror in MIRRORS {
            let url = format!(
                "{mirror}/topics/list?keyword={}",
                urlencoding_escape(keywords)
            );
            match self.http.get(&url).send().await {
                Ok(resp) => match resp.error_for_status() {
                    Ok(r) => match r.text().await {
                        Ok(t) => return Ok(t),
                        Err(e) => last = UserError::network(e),
                    },
                    Err(e) => last = UserError::network(e),
                },
                Err(e) => last = UserError::network(e),
            }
        }
        Err(last)
    }
}

fn urlencoding_escape(s: &str) -> String {
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

/// 从一页 HTML 解析种子条目（纯函数，fixture 单测入口）。
/// 列表行结构（2026-08 抓取实证）：
/// `table#topic_list tbody tr` → 标题链接 `td.title a[href^='/topics/view/']`，
/// 磁链 `a[title='磁力下載']`，大小在 `td[nowrap]`（"48.5GB" 文本）。
pub fn parse_list_page(html: &str) -> Vec<ParsedTorrent> {
    let doc = Html::parse_document(html);
    let row = Selector::parse("table#topic_list tbody tr").unwrap();
    let title = Selector::parse("td.title a[href^='/topics/view/']").unwrap();
    let magnet = Selector::parse("a[title='磁力下載']").unwrap();

    let mut out = Vec::new();
    for tr in doc.select(&row) {
        let Some(a) = tr.select(&title).next() else {
            continue;
        };
        let Some(m) = tr.select(&magnet).next() else {
            continue;
        };
        let text = a.text().collect::<String>();
        let t = a.attr("title").unwrap_or(&text).trim().to_string();
        out.push(ParsedTorrent {
            title: t,
            magnet: m.attr("href").unwrap_or_default().to_string(),
            size_text: size_of_row(&tr),
            date_text: None,
        });
    }
    out
}

/// 行内第三个 `td[nowrap]` 是文件大小。
fn size_of_row(tr: &scraper::element_ref::ElementRef) -> Option<String> {
    let nowrap = Selector::parse("td[nowrap]").unwrap();
    let tds: Vec<_> = tr.select(&nowrap).collect();
    tds.get(2)
        .map(|td| td.text().collect::<String>().trim().to_string())
        .filter(|s| !s.is_empty())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ParsedTorrent {
    pub title: String,
    pub magnet: String,
    pub size_text: Option<String>,
    pub date_text: Option<String>,
}

impl ParsedTorrent {
    /// 解析 "1.5GB" / "1.5 GiB" 这类文本为字节数。
    pub fn size_bytes(&self) -> Option<u64> {
        let s = self.size_text.as_deref()?;
        let num_end = s.find(|c: char| c.is_ascii_alphabetic()).unwrap_or(s.len());
        let num: f64 = s[..num_end].trim().parse().ok()?;
        let unit = s[num_end..].trim().to_ascii_lowercase();
        let mult = match unit.as_str() {
            "kib" | "kb" => 1024.0,
            "mib" | "mb" => 1024.0 * 1024.0,
            "gib" | "gb" => 1024.0 * 1024.0 * 1024.0,
            "tib" | "tb" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
            _ => return None,
        };
        Some((num * mult) as u64)
    }

    pub fn to_media(&self, source_id: &str) -> Media {
        Media {
            media_source_id: source_id.into(),
            title: self.title.clone(),
            kind: MediaKind::FullEpisode,
            episode_id: None,
            properties: MediaProperties {
                resolution: ani_core::Resolution::guess_from_title(&self.title),
                subtitle_group: subtitle_group_of(&self.title),
                size_bytes: self.size_bytes(),
                ..Default::default()
            },
            download: DownloadKind::Torrent {
                uri: self.magnet.clone(),
            },
        }
    }
}

/// 从标题里猜字幕组：`[组名] 标题` 或 `标题 [组名]`。
pub fn subtitle_group_of(title: &str) -> Option<String> {
    let t = title.trim();
    if let Some(rest) = t.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            return Some(rest[..end].to_string());
        }
    }
    if let Some(start) = t.rfind(" [") {
        if t.ends_with(']') {
            return Some(t[start + 2..t.len() - 1].to_string());
        }
    }
    None
}

#[async_trait]
impl MediaSource for DmhySource {
    fn info(&self) -> &MediaSourceInfo {
        &self.info
    }

    async fn fetch(&self, req: &MediaFetchRequest) -> Result<Vec<MediaMatch>, UserError> {
        let mut matches = Vec::new();
        for kw in req.keywords().iter().take(2) {
            // 单个关键词失败不拖垮整体（还有别名/其它源）
            let html = match self.fetch_page(kw).await {
                Ok(h) => h,
                Err(e) => {
                    tracing::warn!("dmhy fetch {kw:?} failed: {e}");
                    continue;
                }
            };
            for t in parse_list_page(&html) {
                matches.push(MediaMatch {
                    match_kind: MatchKind::Fuzzy,
                    media: t.to_media(&self.info.id),
                });
            }
        }
        Ok(matches)
    }
}

/// 供 CLI/域层把候选转成 Candidate::Available 的小工具。
pub fn matches_to_candidates(m: Vec<MediaMatch>) -> Vec<Candidate> {
    m.into_iter()
        .map(|mm| Candidate::Available {
            media: mm.media,
            score: 0.0,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真实页面结构的最小 fixture（2026-08 实证，去版权内容）。
    const FIXTURE: &str = r#"<html><body><table id="topic_list"><tbody>
    <tr>
        <td class="title">
            <a href="/topics/view/1234_x.html" target="_blank">[Group] <span class="keyword">KEYWORD</span>/Show S01 | 01-28 [Sub] 1080p x265</a>
        </td>
        <td nowrap="nowrap" align="center">2026-08-01</td>
        <td nowrap="nowrap" align="center">123</td>
        <td nowrap="nowrap" align="center">1.5GB</td>
        <td nowrap="nowrap" align="center">
            <a class="download-arrow arrow-magnet" title="磁力下載" href="magnet:?xt=urn:btih:ABC"> </a>
        </td>
    </tr>
    <tr><td class="title"><a href="https://other.site/x">no magnet row</a></td></tr>
    </tbody></table></body></html>"#;

    #[test]
    fn parse_real_fixture() {
        let rows = parse_list_page(FIXTURE);
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert!(r.title.contains("[Group]"));
        assert!(r.title.contains("1080p"));
        assert_eq!(r.magnet, "magnet:?xt=urn:btih:ABC");
        assert_eq!(r.size_bytes(), Some(1_610_612_736));
        let m = r.to_media("dmhy");
        assert_eq!(m.properties.subtitle_group.as_deref(), Some("Group"));
        assert_eq!(m.properties.resolution.unwrap().height, 1080);
    }
}
