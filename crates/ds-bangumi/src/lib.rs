//! ds-bangumi —— Bangumi (bgm.tv) v0 REST 客户端。
//!
//! 端点（见拆解文档 10.6）：
//! - `POST /v0/search/subjects` 搜条目
//! - `GET  /calendar` 每日新番时间表（首页）
//! - `GET  /v0/subjects/{id}` 条目详情
//! - `GET  /v0/episodes?subject_id=` 剧集
//!
//! OAuth 登录（wry 弹窗 + localhost 回调）在 M3 GUI 阶段接入，此处先留接口。

pub mod oauth;

use ani_core::{
    Episode, EpisodeId, EpisodeKind, MediaFetchRequest, MediaMatch, MediaSource, MediaSourceInfo,
    MediaSourceKind, MediaSourceTier, SubjectId, SubjectSummary, UserError,
};
use async_trait::async_trait;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use url::Url;

const API: &str = "https://api.bgm.tv";
/// bgm.tv 要求可识别的 UA，否则可能被拒
pub const USER_AGENT: &str = "ani-rs/0.1 (https://github.com/ani-rs/ani-rs)";

#[derive(Debug, Clone)]
pub struct BangumiSource {
    http: Client,
    info: MediaSourceInfo,
}

/// 把 Bangumi 封面 URL 升级到 large 档。
/// URL 规律固定：`lain.bgm.tv/pic/cover/{s|m|c|l|g}/<path>`，尺寸由路径段决定。
pub fn upgrade_cover_url(url: &str) -> Option<Url> {
    let u = url
        .replace("/pic/cover/s/", "/pic/cover/l/")
        .replace("/pic/cover/m/", "/pic/cover/l/")
        .replace("/pic/cover/g/", "/pic/cover/l/")
        .replace("/pic/cover/c/", "/pic/cover/l/");
    Url::parse(&u).ok()
}

/// 从 images 对象里挑最高清的封面：large 优先，medium，common 升级兜底，small，grid。
fn best_cover(images: &Images) -> Option<Url> {
    images
        .large
        .as_deref()
        .and_then(|u| Url::parse(u).ok())
        .or_else(|| images.medium.as_deref().and_then(|u| Url::parse(u).ok()))
        .or_else(|| images.common.as_deref().and_then(upgrade_cover_url))
        .or_else(|| images.small.as_deref().and_then(|u| Url::parse(u).ok()))
        .or_else(|| images.grid.as_deref().and_then(|u| Url::parse(u).ok()))
}

/// 条目关联的角色与配音演员（CV）信息。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CharacterActor {
    pub id: u64,
    pub name: String,
    #[serde(default)]
    pub image_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SubjectCharacter {
    pub id: u64,
    pub name: String,
    pub relation: String,
    #[serde(default)]
    pub image_url: Option<String>,
    #[serde(default)]
    pub actors: Vec<CharacterActor>,
}

/// 条目关联作品信息（前传/续集/剧场版/外传等）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RelatedSubject {
    pub id: u32,
    pub name: String,
    #[serde(default)]
    pub name_cn: String,
    pub relation: String,
    pub subject_type: u8,
    #[serde(default)]
    pub cover_url: Option<String>,
}

/// 一天的放送日程（对应 /calendar 的数组元素）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalendarDay {
    pub weekday: CalendarWeekday,
    pub items: Vec<SubjectSummary>,
}

#[derive(serde::Deserialize, Default, Clone)]
pub struct Images {
    #[serde(default)]
    pub large: Option<String>,
    #[serde(default, rename = "common")]
    pub common: Option<String>,
    #[serde(default)]
    pub medium: Option<String>,
    #[serde(default)]
    pub small: Option<String>,
    #[serde(default)]
    pub grid: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalendarWeekday {
    /// 1 = 周一 … 7 = 周日
    pub id: u8,
    pub cn: String,
}

impl BangumiSource {
    pub fn new() -> anyhow::Result<Self> {
        let http = Client::builder()
            .user_agent(USER_AGENT)
            .timeout(std::time::Duration::from_secs(15))
            .build()?;
        Ok(Self {
            http,
            info: MediaSourceInfo {
                id: "bangumi".into(),
                display_name: "Bangumi".into(),
                kind: MediaSourceKind::Web,
                tier: MediaSourceTier::High,
                enabled: true,
            },
        })
    }

    /// Bangumi 是资料库而非片源，`fetch` 恒返回空（它是元数据源，不是 MediaSource 片源）。
    /// 片源聚合由 dmhy/mikan/web 完成。
    pub async fn search(&self, keyword: &str) -> Result<Vec<SubjectSummary>, UserError> {
        #[derive(serde::Deserialize)]
        struct Resp {
            data: Vec<Item>,
        }
        #[derive(serde::Deserialize)]
        struct Item {
            id: u32,
            #[serde(default)]
            name_cn: String,
            name: String,
            #[serde(default)]
            date: Option<String>,
            #[serde(default)]
            images: Images,
        }
        let r: Resp = self
            .http
            .post(format!("{API}/v0/search/subjects"))
            // filter type=2 只搜动画条目，避免漫画/画集/游戏混入结果
            // （它们没有剧集数据，进 GUI 后只会得到空列表）
            .json(&serde_json::json!({
                "keyword": keyword,
                "filter": { "type": [2] }
            }))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok(r.data
            .into_iter()
            .map(|i| SubjectSummary {
                id: SubjectId(i.id),
                display_title: if i.name_cn.is_empty() {
                    i.name.clone()
                } else {
                    i.name_cn
                },
                original_title: i.name,
                air_date: i.date,
                cover_url: best_cover(&i.images),
            })
            .collect())
    }

    /// 每日新番时间表（GET /calendar，无需登录）——首页数据源。
    pub async fn calendar(&self) -> Result<Vec<CalendarDay>, UserError> {
        #[derive(serde::Deserialize)]
        struct Day {
            weekday: W,
            #[serde(default)]
            items: Vec<Item>,
        }
        #[derive(serde::Deserialize)]
        struct W {
            id: u8,
            #[serde(default)]
            cn: String,
        }
        #[derive(serde::Deserialize)]
        struct Item {
            id: u32,
            #[serde(default)]
            name_cn: String,
            name: String,
            #[serde(default, rename = "air_date")]
            date: Option<String>,
            #[serde(default)]
            images: Images,
        }
        let r: Vec<Day> = self
            .http
            .get(format!("{API}/calendar"))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok(r.into_iter()
            .map(|d| CalendarDay {
                weekday: CalendarWeekday {
                    id: d.weekday.id,
                    cn: d.weekday.cn,
                },
                items: d
                    .items
                    .into_iter()
                    .map(|i| SubjectSummary {
                        id: SubjectId(i.id),
                        display_title: if i.name_cn.is_empty() {
                            i.name.clone()
                        } else {
                            i.name_cn
                        },
                        original_title: i.name,
                        air_date: i.date,
                        cover_url: best_cover(&i.images),
                    })
                    .collect(),
            })
            .collect())
    }

    /// 条目详情。
    pub async fn subject_detail(
        &self,
        SubjectId(id): SubjectId,
    ) -> Result<SubjectSummary, UserError> {
        #[derive(serde::Deserialize)]
        struct Item {
            id: u32,
            #[serde(default)]
            name_cn: String,
            name: String,
            #[serde(default)]
            date: Option<String>,
            #[serde(default)]
            images: serde_json::Value,
        }
        let it: Item = self
            .http
            .get(format!("{API}/v0/subjects/{id}"))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        // 详情接口的 images 直接是 JSON 对象，取 large 优先 / common 升级兜底
        let cover = serde_json::from_value::<Images>(it.images)
            .ok()
            .map(|img| best_cover(&img))
            .unwrap_or(None);
        Ok(SubjectSummary {
            id: SubjectId(it.id),
            display_title: if it.name_cn.is_empty() {
                it.name.clone()
            } else {
                it.name_cn
            },
            original_title: it.name,
            air_date: it.date,
            cover_url: cover,
        })
    }

    /// 剧集列表。
    pub async fn episodes(&self, SubjectId(id): SubjectId) -> Result<Vec<Episode>, UserError> {
        #[derive(serde::Deserialize)]
        struct Resp {
            data: Vec<Item>,
        }
        #[derive(serde::Deserialize)]
        struct Item {
            id: u64,
            // SP/OP/ED 等条目的 ep 可能是显式 null，用 Option 兜底
            // （serde(default) 只兜字段缺失，兜不住 null）
            #[serde(default)]
            ep: Option<f32>,
            #[serde(rename = "type")]
            kind: u8,
            #[serde(default)]
            name_cn: String,
            #[serde(default)]
            name: String,
        }

        let r: Resp = self
            .http
            .get(format!("{API}/v0/episodes"))
            .query(&[("subject_id", id.to_string()), ("limit", "1000".into())])
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok(r.data
            .into_iter()
            .map(|i| Episode {
                id: EpisodeId(i.id),
                subject_id: SubjectId(id),
                ep: i.ep.unwrap_or(0.0),
                kind: EpisodeKind::from_bangumi_type(i.kind),
                display_title: if i.name_cn.is_empty() {
                    i.name
                } else {
                    i.name_cn
                },
            })
            .collect())
    }

    /// 查询条目角色与声优列表（主角与配角排在前面）。
    pub async fn characters(
        &self,
        SubjectId(id): SubjectId,
    ) -> Result<Vec<SubjectCharacter>, UserError> {
        #[derive(serde::Deserialize)]
        struct ActorItem {
            id: u64,
            name: String,
            #[serde(default)]
            images: Option<Images>,
        }
        #[derive(serde::Deserialize)]
        struct CharacterItem {
            id: u64,
            name: String,
            #[serde(default)]
            relation: String,
            #[serde(default)]
            images: Option<Images>,
            #[serde(default)]
            actors: Vec<ActorItem>,
        }

        let resp: Vec<CharacterItem> = self
            .http
            .get(format!("{API}/v0/subjects/{id}/characters"))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;

        let mut list: Vec<SubjectCharacter> = resp
            .into_iter()
            .map(|item| {
                let image_url = item
                    .images
                    .and_then(|img| best_cover(&img))
                    .map(|u| u.to_string());
                let actors = item
                    .actors
                    .into_iter()
                    .map(|a| {
                        let actor_img = a
                            .images
                            .and_then(|img| best_cover(&img))
                            .map(|u| u.to_string());
                        CharacterActor {
                            id: a.id,
                            name: a.name,
                            image_url: actor_img,
                        }
                    })
                    .collect();
                SubjectCharacter {
                    id: item.id,
                    name: item.name,
                    relation: item.relation,
                    image_url,
                    actors,
                }
            })
            .collect();

        // 排序规则：主角 (0) > 配角 (1) > 其它 (2)
        list.sort_by_key(|c| match c.relation.as_str() {
            "主角" => 0,
            "配角" => 1,
            _ => 2,
        });

        Ok(list)
    }

    /// 查询条目关联作品列表（前传/续集/总集篇/衍生等，动画优先）。
    pub async fn related_subjects(
        &self,
        SubjectId(id): SubjectId,
    ) -> Result<Vec<RelatedSubject>, UserError> {
        #[derive(serde::Deserialize)]
        struct RelatedItem {
            id: u32,
            name: String,
            #[serde(default)]
            name_cn: String,
            relation: String,
            #[serde(rename = "type")]
            subject_type: u8,
            #[serde(default)]
            images: Option<Images>,
        }

        let resp: Vec<RelatedItem> = self
            .http
            .get(format!("{API}/v0/subjects/{id}/subjects"))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;

        let mut list: Vec<RelatedSubject> = resp
            .into_iter()
            .map(|item| {
                let cover_url = item
                    .images
                    .and_then(|img| best_cover(&img))
                    .map(|u| u.to_string());
                RelatedSubject {
                    id: item.id,
                    name: item.name,
                    name_cn: item.name_cn,
                    relation: item.relation,
                    subject_type: item.subject_type,
                    cover_url,
                }
            })
            .collect();

        // 排序规则：动画 (subject_type == 2) 优先排前，
        // 关系优先级：续集 (0) = 前传 (0) > 总集篇 (1) = 番外篇 (1) > 相同世界观 (2) = 衍生 (2) > 其它 (3)
        list.sort_by_key(|r| {
            let type_rank = if r.subject_type == 2 { 0 } else { 1 };
            let relation_rank = match r.relation.as_str() {
                "前传" | "续集" => 0,
                "总集篇" | "番外篇" | "片头片尾" => 1,
                "相同世界观" | "衍生" | "系列" => 2,
                _ => 3,
            };
            (type_rank, relation_rank)
        });

        Ok(list)
    }
}

#[async_trait]
impl MediaSource for BangumiSource {
    fn info(&self) -> &MediaSourceInfo {
        &self.info
    }

    async fn fetch(&self, _req: &MediaFetchRequest) -> Result<Vec<MediaMatch>, UserError> {
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cover_url_upgrade() {
        // common/medium/small/grid 段都应升级为 large
        assert_eq!(
            upgrade_cover_url("http://lain.bgm.tv/pic/cover/c/12/34/456080_C4q4C.jpg")
                .map(|u| u.to_string()),
            Some("http://lain.bgm.tv/pic/cover/l/12/34/456080_C4q4C.jpg".to_string())
        );
        assert_eq!(
            upgrade_cover_url("http://lain.bgm.tv/pic/cover/m/12/34/456080_C4q4C.jpg")
                .map(|u| u.to_string()),
            Some("http://lain.bgm.tv/pic/cover/l/12/34/456080_C4q4C.jpg".to_string())
        );
        // 已经是 large 的不动
        assert_eq!(
            upgrade_cover_url("http://lain.bgm.tv/pic/cover/l/12/34/456080_C4q4C.jpg")
                .map(|u| u.to_string()),
            Some("http://lain.bgm.tv/pic/cover/l/12/34/456080_C4q4C.jpg".to_string())
        );
    }

    #[test]
    fn best_cover_prefers_large() {
        let img = Images {
            large: Some("http://lain.bgm.tv/pic/cover/l/12/34/1.jpg".into()),
            common: Some("http://lain.bgm.tv/pic/cover/c/12/34/1.jpg".into()),
            ..Default::default()
        };
        assert_eq!(
            best_cover(&img).map(|u| u.to_string()),
            Some("http://lain.bgm.tv/pic/cover/l/12/34/1.jpg".to_string())
        );
        // 只有 common 时升级
        let img2 = Images {
            large: None,
            common: Some("http://lain.bgm.tv/pic/cover/c/12/34/1.jpg".into()),
            ..Default::default()
        };
        assert_eq!(
            best_cover(&img2).map(|u| u.to_string()),
            Some("http://lain.bgm.tv/pic/cover/l/12/34/1.jpg".to_string())
        );
    }

    #[test]
    fn characters_sorting_priority() {
        let mut chars = [
            SubjectCharacter {
                id: 3,
                name: "闲人甲".into(),
                relation: "闲角".into(),
                image_url: None,
                actors: vec![],
            },
            SubjectCharacter {
                id: 1,
                name: "芙莉莲".into(),
                relation: "主角".into(),
                image_url: Some("http://example.com/frieren.jpg".into()),
                actors: vec![CharacterActor {
                    id: 101,
                    name: "种崎敦美".into(),
                    image_url: None,
                }],
            },
            SubjectCharacter {
                id: 2,
                name: "费伦".into(),
                relation: "配角".into(),
                image_url: None,
                actors: vec![],
            },
        ];

        chars.sort_by_key(|c| match c.relation.as_str() {
            "主角" => 0,
            "配角" => 1,
            _ => 2,
        });

        assert_eq!(chars[0].name, "芙莉莲");
        assert_eq!(chars[1].name, "费伦");
        assert_eq!(chars[2].name, "闲人甲");
        assert_eq!(chars[0].actors[0].name, "种崎敦美");
    }

    #[test]
    fn related_subjects_sorting_priority() {
        let mut list = [
            RelatedSubject {
                id: 10,
                name: "原声音乐集".into(),
                name_cn: "".into(),
                relation: "原声集".into(),
                subject_type: 3, // 音乐
                cover_url: None,
            },
            RelatedSubject {
                id: 20,
                name: "第二季".into(),
                name_cn: "第二季".into(),
                relation: "续集".into(),
                subject_type: 2, // 动画
                cover_url: Some("http://example.com/s2.jpg".into()),
            },
            RelatedSubject {
                id: 30,
                name: "剧场版 总集篇".into(),
                name_cn: "剧场版".into(),
                relation: "总集篇".into(),
                subject_type: 2, // 动画
                cover_url: None,
            },
            RelatedSubject {
                id: 40,
                name: "衍生同人小说".into(),
                name_cn: "".into(),
                relation: "衍生".into(),
                subject_type: 1, // 书籍
                cover_url: None,
            },
        ];

        list.sort_by_key(|r| {
            let type_rank = if r.subject_type == 2 { 0 } else { 1 };
            let relation_rank = match r.relation.as_str() {
                "前传" | "续集" => 0,
                "总集篇" | "番外篇" | "片头片尾" => 1,
                "相同世界观" | "衍生" | "系列" => 2,
                _ => 3,
            };
            (type_rank, relation_rank)
        });

        assert_eq!(list[0].id, 20); // 动画 续集
        assert_eq!(list[1].id, 30); // 动画 总集篇
        assert_eq!(list[2].id, 40); // 书籍 衍生
        assert_eq!(list[3].id, 10); // 音乐 原声集
    }
}
