//! Bangumi OAuth2 + 收藏/进度 API（对应 Ani 的 `:datasource:bangumi` 账号链路）。
//!
//! 凭据在 [bgm.tv 开发者平台](https://bgm.tv/dev/app) 免费创建应用获得（ClientID/Secret）。
//! 授权采用「授权码粘贴」流程：打开授权页 → 登录后复制授权码 → 回到应用粘贴换取 token
//! （应用未配置回调地址时 bgm.tv 会在页面上直接显示授权码，无需本地回调服务器）。
//!
//! 端点（拆解文档 10.6）：
//! - `GET  https://bgm.tv/oauth/authorize`（浏览器打开）
//! - `POST https://bgm.tv/oauth/access_token`（换/刷 token）
//! - `GET  /v0/me`（当前用户）
//! - `POST /v0/users/-/collections/{subject_id}`（收藏条目；type: 1想看 2看过 3在看）
//! - `PATCH /v0/users/-/collections/{subject_id}/episodes/{episode_id}`（剧集进度；type 2=看过）

use anyhow::Context;
use serde::{Deserialize, Serialize};

use crate::{API, USER_AGENT};

#[derive(Debug, Clone)]
pub struct BangumiOAuth {
    http: reqwest::Client,
}

/// 一次 token 响应（授权码换取或刷新）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenSet {
    pub access_token: String,
    pub refresh_token: String,
    /// 有效期（秒）
    pub expires_in: u64,
}

impl TokenSet {
    /// 绝对过期时间（unix 毫秒）。
    pub fn expires_at_ms(&self) -> i64 {
        chrono::Utc::now().timestamp_millis() + (self.expires_in as i64) * 1000
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BgmUser {
    pub id: u32,
    #[serde(default)]
    pub nickname: String,
    #[serde(default)]
    pub username: String,
}

/// 用户在 Bangumi 上的条目收藏与评价详情。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserSubjectCollection {
    /// 1: 想看, 2: 看过, 3: 在看, 4: 搁置, 5: 抛弃
    #[serde(rename = "type")]
    pub collection_type: u8,
    #[serde(default)]
    pub rate: u8,
    #[serde(default)]
    pub comment: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub private: bool,
    #[serde(default)]
    pub updated_at: Option<String>,
}

impl BangumiOAuth {
    pub fn new() -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(std::time::Duration::from_secs(20))
            .build()?;
        Ok(Self { http })
    }

    /// 浏览器打开的授权页 URL。redirect_uri 为空表示应用未配置回调（页面直接显示授权码）。
    pub fn auth_url(client_id: &str, redirect_uri: &str) -> String {
        let mut u = format!(
            "https://bgm.tv/oauth/authorize?client_id={}&response_type=code",
            urlencode(client_id)
        );
        if !redirect_uri.trim().is_empty() {
            u.push_str("&redirect_uri=");
            u.push_str(&urlencode(redirect_uri.trim()));
        }
        u
    }

    async fn token_request(&self, form: &[(&str, &str)]) -> anyhow::Result<TokenSet> {
        let r: TokenSet = self
            .http
            .post("https://bgm.tv/oauth/access_token")
            .header("User-Agent", USER_AGENT)
            .form(form)
            .send()
            .await
            .context("bgm token request failed")?
            .error_for_status()
            .context(
                "bgm token rejected（检查 ClientID/Secret/授权码/回调地址是否与创建的应用一致）",
            )?
            .json()
            .await
            .context("bgm token bad json")?;
        Ok(r)
    }

    /// 授权码换 token。
    pub async fn exchange_code(
        &self,
        client_id: &str,
        client_secret: &str,
        code: &str,
        redirect_uri: &str,
    ) -> anyhow::Result<TokenSet> {
        let mut form = vec![
            ("grant_type", "authorization_code"),
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("code", code.trim()),
        ];
        if !redirect_uri.trim().is_empty() {
            form.push(("redirect_uri", redirect_uri.trim()));
        }
        self.token_request(&form).await
    }

    /// 刷新 token。
    pub async fn refresh(
        &self,
        client_id: &str,
        client_secret: &str,
        refresh_token: &str,
    ) -> anyhow::Result<TokenSet> {
        self.token_request(&[
            ("grant_type", "refresh_token"),
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("refresh_token", refresh_token),
        ])
        .await
    }

    async fn get_json<B: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        token: &str,
    ) -> anyhow::Result<B> {
        self.http
            .get(format!("{API}{path}"))
            .bearer_auth(token)
            .send()
            .await
            .context("bgm api request failed")?
            .error_for_status()
            .context("bgm api rejected（token 可能已失效，请重新登录）")?
            .json()
            .await
            .context("bgm api bad json")
    }

    /// 当前用户。
    pub async fn me(&self, token: &str) -> anyhow::Result<BgmUser> {
        self.get_json("/v0/me", token).await
    }

    /// 获取当前用户对指定条目的收藏状态与评分。未收藏返回 Ok(None)。
    pub async fn get_subject_collection(
        &self,
        token: &str,
        subject_id: u32,
    ) -> anyhow::Result<Option<UserSubjectCollection>> {
        let r = self
            .http
            .get(format!("{API}/v0/users/-/collections/{subject_id}"))
            .bearer_auth(token)
            .send()
            .await
            .context("bgm get collection request failed")?;

        if r.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }

        let resp = r
            .error_for_status()
            .context("bgm get collection rejected")?;
        let col: UserSubjectCollection =
            resp.json().await.context("bgm get collection bad json")?;
        Ok(Some(col))
    }

    /// 完整设置条目收藏（状态、评分、短评、标签、私密）。
    #[allow(clippy::too_many_arguments)]
    pub async fn set_subject_collection_full(
        &self,
        token: &str,
        subject_id: u32,
        collection_type: u8,
        rate: Option<u8>,
        comment: Option<&str>,
        tags: Option<&[String]>,
        private: Option<bool>,
    ) -> anyhow::Result<()> {
        let mut body = serde_json::json!({
            "type": collection_type,
        });
        if let Some(r) = rate {
            body["rate"] = serde_json::json!(r);
        }
        if let Some(c) = comment {
            body["comment"] = serde_json::json!(c);
        }
        if let Some(t) = tags {
            body["tags"] = serde_json::json!(t);
        }
        if let Some(p) = private {
            body["private"] = serde_json::json!(p);
        }

        let r = self
            .http
            .post(format!("{API}/v0/users/-/collections/{subject_id}"))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .context("bgm set collection request failed")?;

        if r.status() == reqwest::StatusCode::CONFLICT || r.status().is_success() {
            return Ok(());
        }
        r.error_for_status()
            .context("bgm set collection rejected")?;
        Ok(())
    }

    /// 收藏条目（type: 1想看 2看过 3在看 4搁置 5抛弃）。
    pub async fn collect_subject(
        &self,
        token: &str,
        subject_id: u32,
        collection_type: u8,
    ) -> anyhow::Result<()> {
        let r = self
            .http
            .post(format!("{API}/v0/users/-/collections/{subject_id}"))
            .bearer_auth(token)
            .json(&serde_json::json!({ "type": collection_type }))
            .send()
            .await
            .context("bgm collect request failed")?;
        // 重复收藏等幂等场景不视为错误
        if r.status() == reqwest::StatusCode::CONFLICT || r.status().is_success() {
            return Ok(());
        }
        r.error_for_status().context("bgm collect rejected")?;
        Ok(())
    }

    /// 标记某集「看过」（type=2）。条目未收藏时自动建立「在看」收藏再打卡。
    pub async fn mark_episode_watched(
        &self,
        token: &str,
        subject_id: u32,
        episode_id: u64,
    ) -> anyhow::Result<()> {
        let patch = |x: &Self| {
            x.http
                .patch(format!(
                    "{API}/v0/users/-/collections/{subject_id}/episodes/{episode_id}"
                ))
                .bearer_auth(token)
                .json(&serde_json::json!({ "type": 2 }))
        };
        let r = patch(self)
            .send()
            .await
            .context("bgm progress request failed")?;
        if r.status().is_success() {
            return Ok(());
        }
        let status = r.status();
        if status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::FORBIDDEN {
            // 未收藏 → 先建「在看」收藏，再打卡一次
            self.collect_subject(token, subject_id, 3).await?;
            patch(self)
                .send()
                .await
                .context("bgm progress retry failed")?
                .error_for_status()
                .context("bgm progress rejected after collect")?;
            return Ok(());
        }
        anyhow::bail!("bgm progress rejected: {status}")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_url_builds_correctly() {
        let u = BangumiOAuth::auth_url("myid", "");
        assert_eq!(
            u,
            "https://bgm.tv/oauth/authorize?client_id=myid&response_type=code"
        );
        // 带回调地址时要编码
        let u2 = BangumiOAuth::auth_url("myid", "http://localhost:2333/cb");
        assert!(u2.contains("&redirect_uri=http%3A%2F%2Flocalhost%3A2333%2Fcb"));
    }

    #[test]
    fn token_set_expiry_math() {
        let t = TokenSet {
            access_token: "a".into(),
            refresh_token: "r".into(),
            expires_in: 3600,
        };
        let at = t.expires_at_ms();
        let now = chrono::Utc::now().timestamp_millis();
        assert!((at - now - 3_600_000).abs() < 2000);
    }

    #[test]
    fn test_user_subject_collection_deser() {
        let json = r#"{
            "type": 3,
            "rate": 8,
            "comment": "作画绝美，音乐催泪",
            "tags": ["奇幻", "冒险", "治愈"],
            "private": false,
            "updated_at": "2026-09-01T12:00:00Z"
        }"#;
        let col: UserSubjectCollection = serde_json::from_str(json).unwrap();
        assert_eq!(col.collection_type, 3);
        assert_eq!(col.rate, 8);
        assert_eq!(col.comment.as_deref(), Some("作画绝美，音乐催泪"));
        assert_eq!(col.tags.len(), 3);
        assert!(!col.private);
    }
}
