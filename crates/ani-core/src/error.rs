//! 两级错误模型（对应蓝图 8.2）：`anyhow::Error` 只活在 crate 内部，
//! 跨越 command / 数据源边界时统一收敛为 `UserError`，前端按 `kind` 出本地化文案。

use serde::Serialize;

#[derive(thiserror::Error, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UserError {
    #[error("network error: {detail}")]
    Network { detail: String },
    #[error("source blocked: {source_name}")]
    SourceBlocked { source_name: String },
    #[error("captcha required: {source_name}")]
    CaptchaRequired { source_name: String },
    #[error("not found")]
    NotFound,
    #[error("internal: {detail}")]
    Internal { detail: String },
}

impl UserError {
    pub fn network(e: impl std::fmt::Display) -> Self {
        Self::Network {
            detail: e.to_string(),
        }
    }
    pub fn internal(e: impl std::fmt::Display) -> Self {
        Self::Internal {
            detail: e.to_string(),
        }
    }
}

impl From<reqwest::Error> for UserError {
    fn from(e: reqwest::Error) -> Self {
        // 去掉 URL：长查询关键词会把前端错误横幅刷成一大段编码串
        Self::Network {
            detail: e.without_url().to_string(),
        }
    }
}
