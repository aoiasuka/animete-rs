//! dandanplay 弹幕源客户端（对应 Ani 的 `:danmaku:dandanplay`）。
//!
//! 开放 API 需要在弹弹play 开放平台免费申请 AppId/AppSecret（设置页填写）：
//! 每个请求带 `X-AppId` + `X-Signature`，签名 = base64(HMAC-SHA256(key=AppSecret, msg=AppId+UNIX秒))。
//!
//! 流程：`search_episode`（按番名找 episodeId）→ `fetch_comments`（弹幕池）
//! → 解析为 [`DanmakuEvent`] 交给引擎层过滤/去重。

use crate::{DanmakuEvent, DanmakuMode};
use anyhow::Context;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;

const API: &str = "https://api.dandanplay.net";
pub const USER_AGENT: &str = "ani-rs/0.1 (https://github.com/ani-rs/ani-rs)";

#[derive(Debug, Clone)]
pub struct DandanplayClient {
    http: reqwest::Client,
    app_id: String,
    app_secret: String,
}

impl DandanplayClient {
    pub fn new(app_id: impl Into<String>, app_secret: impl Into<String>) -> Self {
        Self {
            http: reqwest::Client::builder()
                .user_agent(USER_AGENT)
                .timeout(std::time::Duration::from_secs(20))
                .build()
                .expect("reqwest client"),
            app_id: app_id.into(),
            app_secret: app_secret.into(),
        }
    }

    /// dandanplay 开放 API 鉴权头：X-AppId + X-Signature(base64(HMAC-SHA256(AppSecret, AppId+时间戳)))
    fn signature(&self, timestamp: u64) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(self.app_secret.as_bytes())
            .expect("hmac accepts any key length");
        mac.update(format!("{}{}", self.app_id, timestamp).as_bytes());
        base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())
    }

    fn get(&self, path: &str) -> reqwest::RequestBuilder {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        self.http
            .get(format!("{API}{path}"))
            .header("X-AppId", &self.app_id)
            .header("X-Signature", self.signature(ts))
    }

    /// 按番名搜索剧集条目。
    pub async fn search_episode(&self, anime: &str) -> anyhow::Result<Vec<EpisodeEntry>> {
        #[derive(Deserialize)]
        struct Resp {
            #[serde(default, rename = "animes")]
            animes: Vec<Anime>,
        }
        #[derive(Deserialize)]
        struct Anime {
            #[serde(default, rename = "animeTitle")]
            anime_title: String,
            #[serde(default)]
            episodes: Vec<Ep>,
        }
        #[derive(Deserialize)]
        struct Ep {
            #[serde(rename = "episodeId")]
            episode_id: i64,
            #[serde(rename = "episodeTitle")]
            episode_title: String,
        }
        let resp: Resp = self
            .get(&format!(
                "/api/v2/search/episodes?anime={}",
                urlencoding_lite(anime)
            ))
            .send()
            .await
            .context("dandanplay search request failed")?
            .error_for_status()
            .context("dandanplay search rejected")?
            .json()
            .await
            .context("dandanplay search bad json")?;
        Ok(resp
            .animes
            .into_iter()
            .flat_map(|a| {
                a.episodes.into_iter().map(move |e| EpisodeEntry {
                    anime_title: a.anime_title.clone(),
                    episode_id: e.episode_id,
                    episode_title: e.episode_title,
                })
            })
            .collect())
    }

    /// 拉取某集的弹幕（含第三方源聚合，转简体）。
    pub async fn fetch_comments(&self, episode_id: i64) -> anyhow::Result<Vec<DanmakuEvent>> {
        #[derive(Deserialize)]
        struct Resp {
            #[serde(default)]
            comments: Vec<RawComment>,
        }
        #[derive(Deserialize)]
        struct RawComment {
            /// "秒.毫秒,模式,颜色十进制,来源"
            #[serde(default)]
            p: String,
            #[serde(default)]
            m: String,
        }
        let resp: Resp = self
            .get(&format!(
                "/api/v2/comment/{episode_id}?withRelated=true&chConvert=1"
            ))
            .send()
            .await
            .context("dandanplay comment request failed")?
            .error_for_status()
            .context("dandanplay comment rejected")?
            .json()
            .await
            .context("dandanplay comment bad json")?;
        Ok(resp
            .comments
            .iter()
            .filter_map(|c| parse_raw_comment(&c.p, &c.m))
            .collect())
    }

    /// 一步到位：按番名+集号搜索并拉取弹幕。
    /// 返回 (匹配到的条目标题, 弹幕)；番名/集号对不上时返回 None。
    pub async fn fetch_episode_comments(
        &self,
        anime: &str,
        ep: f32,
    ) -> anyhow::Result<Option<(String, Vec<DanmakuEvent>)>> {
        let entries = self.search_episode(anime).await?;
        let Some(hit) = pick_episode(&entries, ep) else {
            return Ok(None);
        };
        let comments = self.fetch_comments(hit.episode_id).await?;
        Ok(Some((hit_title(hit), comments)))
    }
}

#[derive(Debug, Clone)]
pub struct EpisodeEntry {
    pub anime_title: String,
    pub episode_id: i64,
    pub episode_title: String,
}

fn hit_title(hit: &EpisodeEntry) -> String {
    if hit.episode_title.trim().is_empty() {
        hit.anime_title.clone()
    } else {
        format!("{} {}", hit.anime_title, hit.episode_title)
    }
}

/// 从搜索结果里挑与集号一致的一集；没有集号请求或无匹配时取第一集。
fn pick_episode(entries: &[EpisodeEntry], ep: f32) -> Option<&EpisodeEntry> {
    let first = entries.first()?;
    entries
        .iter()
        .find(|e| matches!(episode_number(&e.episode_title), Some(n) if (n - ep).abs() < 0.01))
        .or(Some(first))
}

/// dandanplay 的集标题形如 "第01话 …"/"01 …"/"OVA"，取其中的首个数字当集号。
fn episode_number(title: &str) -> Option<f32> {
    let t: Vec<char> = title.chars().collect();
    let mut i = 0;
    while i < t.len() {
        if t[i].is_ascii_digit() {
            let start = i;
            while i < t.len() && (t[i].is_ascii_digit() || t[i] == '.') {
                i += 1;
            }
            let num: String = t[start..i].iter().collect();
            if let Ok(v) = num.parse::<f32>() {
                if v > 0.0 && v < 2000.0 {
                    return Some(v);
                }
            }
        } else {
            i += 1;
        }
    }
    None
}

/// 解析单条原始弹幕（p = "时间秒,模式,颜色十进制,来源"）。
pub fn parse_raw_comment(p: &str, m: &str) -> Option<DanmakuEvent> {
    let mut seg = p.split(',');
    let time_s: f32 = seg.next()?.trim().parse().ok()?;
    let mode: u8 = seg.next().and_then(|s| s.trim().parse().ok()).unwrap_or(1);
    let color: u32 = seg
        .next()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0xFF_FF_FF);
    if m.is_empty() {
        return None;
    }
    Some(DanmakuEvent {
        time_ms: (time_s * 1000.0) as i64,
        mode: match mode {
            4 => DanmakuMode::Bottom,
            5 => DanmakuMode::Top,
            6 => DanmakuMode::Reverse,
            _ => DanmakuMode::Scroll,
        },
        color: color & 0xFF_FF_FF,
        sender: None,
        text: m.to_string(),
        weight: 5,
    })
}

fn urlencoding_lite(s: &str) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_is_deterministic_base64_hmac() {
        let c = DandanplayClient::new("appid", "secret");
        let s = c.signature(1_700_000_000);
        // 同输入同输出，且是合法 base64（32 字节 HMAC → 44 字符）
        assert_eq!(s, c.signature(1_700_000_000));
        assert_eq!(s.len(), 44);
        let other = c.signature(1_700_000_001);
        assert_ne!(s, other);
    }

    #[test]
    fn parse_comment_fields() {
        let d = parse_raw_comment("125.4,1,16711680,0", "好耶").unwrap();
        assert_eq!(d.time_ms, 125_400);
        assert_eq!(d.mode, DanmakuMode::Scroll);
        assert_eq!(d.color, 0xFF0000);
        assert_eq!(d.text, "好耶");
        // 顶部弹幕（模式 5）与坏数据
        assert_eq!(
            parse_raw_comment("10,5,255,0", "顶").unwrap().mode,
            DanmakuMode::Top
        );
        assert!(parse_raw_comment("abc,1,1,0", "x").is_none());
        assert!(parse_raw_comment("10,1,1,0", "").is_none());
    }

    #[test]
    fn pick_episode_by_number() {
        let entries = vec![
            EpisodeEntry {
                anime_title: "Frieren".into(),
                episode_id: 1,
                episode_title: "第03话 杀死魔法师".into(),
            },
            EpisodeEntry {
                anime_title: "Frieren".into(),
                episode_id: 2,
                episode_title: "第01话 序章".into(),
            },
            EpisodeEntry {
                anime_title: "Frieren".into(),
                episode_id: 3,
                episode_title: "OVA".into(),
            },
        ];
        assert_eq!(pick_episode(&entries, 1.0).unwrap().episode_id, 2);
        assert_eq!(pick_episode(&entries, 3.0).unwrap().episode_id, 1);
        // 对不上时回落第一集
        assert_eq!(pick_episode(&entries, 99.0).unwrap().episode_id, 1);
    }

    #[test]
    fn search_response_parsing() {
        // 验证 search 的 serde 结构与真实响应字段（animeTitle/episodeId/episodeTitle）对齐
        let raw = r#"{"animes":[{"animeId":1,"animeTitle":"葬送的芙莉莲","type":"tv","episodes":[{"animeId":1,"animeTitle":"葬送的芙莉莲","episodeId":1337,"episodeTitle":"第01话 序章"}]}]}"#;
        #[derive(Deserialize)]
        struct Resp {
            #[serde(default, rename = "animes")]
            animes: Vec<Anime>,
        }
        #[derive(Deserialize)]
        struct Anime {
            #[serde(default, rename = "animeTitle")]
            anime_title: String,
            #[serde(default)]
            episodes: Vec<Ep>,
        }
        #[derive(Deserialize)]
        struct Ep {
            #[serde(rename = "episodeId")]
            episode_id: i64,
            #[serde(rename = "episodeTitle")]
            episode_title: String,
        }
        let r: Resp = serde_json::from_str(raw).unwrap();
        assert_eq!(r.animes[0].anime_title, "葬送的芙莉莲");
        assert_eq!(r.animes[0].episodes[0].episode_id, 1337);
        assert_eq!(r.animes[0].episodes[0].episode_title, "第01话 序章");
    }
}
