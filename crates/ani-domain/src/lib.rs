//! 自动选源引擎（对应 Ani `domain/media/selector`）。
//!
//! 设计关键词：**偏好 + 可解释排除 + 源分级**。
//! 纯函数、无网络、无 GUI，100% 可测——这是把业务逻辑从 command 层挤出去的收益。

use ani_core::{
    Candidate, DownloadKind, EpisodeId, ExcludeReason, MatchKind, Media, MediaFetchRequest,
    MediaSourceTier, Resolution,
};
use serde::{Deserialize, Serialize};
use smol_str::SmolStr;
use std::collections::HashSet;

/// 用户偏好（对应 MediaPreferenceItem / MediaSelectorSubtitlePreferences）。
/// 由"用户手选一次 → 存为偏好"（MediaSelectorEventSavePreferenceUseCase）持续学习。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct MediaPreference {
    /// 字幕组白名单（模糊匹配，大小写不敏感）
    pub subtitle_group: Option<String>,
    /// 期望分辨率（按高度比接近度打分）
    pub resolution: Option<Resolution>,
    /// 分辨率下限（低于直接排除）
    pub min_resolution_height: Option<u32>,
    /// 拉黑关键词（命中标题即排除）
    pub blacklist_keywords: HashSet<String>,
    /// 拉黑字幕组
    pub blacklist_groups: HashSet<String>,
}

/// 选源上下文。
#[derive(Debug, Clone, Default)]
pub struct SelectorContext {
    pub episode: Option<f32>,
    /// 源分级表（源 id → tier），缺省 Medium
    pub tiers: Vec<(SmolStr, MediaSourceTier)>,
}

impl SelectorContext {
    pub fn source_tier(&self, media: &Media) -> f32 {
        let tier = self
            .tiers
            .iter()
            .find(|(id, _)| id == &media.media_source_id)
            .map(|(_, t)| *t)
            .unwrap_or(MediaSourceTier::Medium);
        match tier {
            MediaSourceTier::High => 3.0,
            MediaSourceTier::Medium => 2.0,
            MediaSourceTier::Low => 1.0,
        }
    }
}

/// 评分函数（对应蓝图 7.2）。
pub fn score(media: &Media, pref: &MediaPreference, ctx: &SelectorContext) -> f32 {
    let mut s = ctx.source_tier(media) * 10.0;

    // 字幕组偏好：完全匹配 +8，前缀模糊 +4
    if let (Some(want), Some(group)) = (&pref.subtitle_group, &media.properties.subtitle_group) {
        let (w, g) = (want.to_lowercase(), group.to_lowercase());
        if g == *w {
            s += 8.0;
        } else if g.contains(&w) || w.contains(&g) {
            s += 4.0;
        }
    }

    // 分辨率偏好：按高度差衰减
    if let (Some(want), Some(res)) = (&pref.resolution, media.properties.resolution) {
        let diff = (res.height as f32 - want.height as f32).abs();
        s += 6.0 * (1.0 / (1.0 + diff / 240.0));
    }

    // 大小合理性：过小=预告/片段，过大=全集合集，都惩罚
    if let Some(sz) = media.properties.size_bytes {
        let mib = sz / (1024.0 * 1024.0) as u64;
        if mib < 100 {
            s -= 8.0;
        } else if mib > 20_000 {
            s -= 6.0;
        }
    }

    s
}

/// 判定一个候选为何被排除；返回 None 表示可用。
pub fn exclusion_reason(
    media: &Media,
    pref: &MediaPreference,
    ctx: &SelectorContext,
) -> Option<ExcludeReason> {
    // 黑名单关键词（空串会让 contains 恒真，过滤掉）
    let title_lc = media.title.to_lowercase();
    if pref.blacklist_keywords.iter().any(|k| {
        let k = k.trim().to_lowercase();
        !k.is_empty() && title_lc.contains(&k)
    }) {
        return Some(ExcludeReason::Blacklisted);
    }
    if let Some(g) = &media.properties.subtitle_group {
        if pref
            .blacklist_groups
            .iter()
            .any(|k| !k.trim().is_empty() && k.trim().eq_ignore_ascii_case(g))
        {
            return Some(ExcludeReason::Blacklisted);
        }
    }
    // 分辨率下限
    if let (Some(min), Some(res)) = (pref.min_resolution_height, media.properties.resolution) {
        if res.height < min {
            return Some(ExcludeReason::ResolutionTooLow);
        }
    }
    // 剧集序号匹配：标题里出现明确单集号（"- 22"、"[22]"、"第22话"）时须与请求一致；
    // 无集号或范围合集（"01-23"）视为匹配任意集
    if let Some(ep) = ctx.episode {
        if let Some(TitleEpisode::Single(n)) = episode_in_title(&media.title) {
            if (n - ep).abs() > 0.01 {
                return Some(ExcludeReason::EpisodeMismatch);
            }
        }
    }
    None
}

/// 标题里解析出的剧集信息。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TitleEpisode {
    /// 明确的单集号
    Single(f32),
    /// 范围合集（"01-23"），包含任意单集
    Range,
}

/// 从标题提取剧集号。
///
/// 策略：正向扫描，只认**有定界符上下文**的数字（前缀是 `[ (- / | 空格 _`，
/// 后缀是 `] ) 空格 - _ | v`），并绕开字幕组标题里的一切数字假阳性：
/// 分辨率 `1080p`、位深 `8bit`、编码 `x265`/`h264`（前缀非定界符）、
/// 季号 `S01`/`第2季`/`Season 2`、声道 `2.0`/`5.1`、容器 `MP4`、年/日期区间等。
/// `S01E05` 形式取 E 后的集号。纯函数，fixture 单测兜底。
pub fn episode_in_title(title: &str) -> Option<TitleEpisode> {
    let t: Vec<char> = title.replace(['【', '】'], "[]").chars().collect();

    // 0) "S01E05"/"S01 E05" 形式（季+集）优先：取 E 后的集号，季号不参与匹配
    {
        let mut i = 0;
        while i + 1 < t.len() {
            // S 前不能是字母/数字（排除 "1080PS1E2"、哈希串之类）
            let boundary = i == 0 || !t[i - 1].is_ascii_alphanumeric();
            if boundary && matches!(t[i], 'S' | 's') && t[i + 1].is_ascii_digit() {
                let mut j = i + 1;
                while j < t.len() && t[j].is_ascii_digit() {
                    j += 1;
                }
                // 允许季号与 E 之间有空格（"S02 E05"）；"S01 Episode 5" 因 E 后非数字不命中
                while j < t.len() && t[j] == ' ' {
                    j += 1;
                }
                if j + 1 < t.len() && matches!(t[j], 'E' | 'e') && t[j + 1].is_ascii_digit() {
                    let e0 = j + 1;
                    let mut k = e0;
                    while k < t.len() && t[k].is_ascii_digit() {
                        k += 1;
                    }
                    let num: String = t[e0..k].iter().collect();
                    if let Ok(v) = num.parse::<f32>() {
                        if v > 0.0 && v < 2000.0 {
                            return Some(TitleEpisode::Single(v));
                        }
                    }
                }
            }
            i += 1;
        }
    }

    // 1) "第 N 话/集/話" 优先；"第N季" 是季号不是集号，跳过
    let mut i = 0;
    while i < t.len() {
        if t[i] == '第' {
            let num: String = t[i + 1..]
                .iter()
                .take_while(|c| c.is_ascii_digit() || **c == '.')
                .collect();
            let after = t[i + 1 + num.len()..].first().copied().unwrap_or(' ');
            if matches!(after, '话' | '話' | '集') {
                if let Ok(v) = num.parse::<f32>() {
                    if v > 0.0 && v < 2000.0 {
                        return Some(TitleEpisode::Single(v));
                    }
                }
            }
        }
        i += 1;
    }

    // 2) 定界符上下文的数字
    let is_delim = |c: char| matches!(c, '[' | '(' | '-' | '/' | '|' | ' ' | '_');
    // "Season 2" 的 "2" 是季号：识别数字前紧跟的 season 字样
    let prev_word_is_season = |t: &[char], start: usize| -> bool {
        if start < 2 || t[start - 1] != ' ' {
            return false;
        }
        let e = start - 1;
        let s = t[..e]
            .iter()
            .rposition(|c| !c.is_ascii_alphabetic())
            .map(|p| p + 1)
            .unwrap_or(0);
        let word: String = t[s..e].iter().collect::<String>().to_lowercase();
        word == "season"
    };
    let mut i = 0;
    // 跳过 "2026-08-01"/"2019-2020" 这类年/日期区间的后续段
    let mut in_date = false;
    while i < t.len() {
        if t[i].is_ascii_digit() {
            // 只从数字段起点进入
            if i > 0 && (t[i - 1].is_ascii_digit() || t[i - 1] == '.') {
                i += 1;
                continue;
            }
            let start = i;
            while i < t.len() && (t[i].is_ascii_digit() || t[i] == '.') {
                i += 1;
            }
            let num: String = t[start..i].iter().collect();
            let prev = if start == 0 { ' ' } else { t[start - 1] };
            let next = if i == t.len() { ' ' } else { t[i] };

            // 数字后紧跟 "-数字"：先判断是不是年/日期区间
            let year_like =
                num.parse::<f32>().map(|v| v >= 1900.0).unwrap_or(true) && !num.contains('.');
            let followed_by_range = next == '-' && i + 1 < t.len() && t[i + 1].is_ascii_digit();
            if year_like && followed_by_range {
                in_date = true;
                continue;
            }
            if in_date && prev == '-' {
                continue;
            }
            in_date = false;

            let prev_ok = is_delim(prev);
            let next_ok = matches!(
                next,
                ']' | ')' | ' ' | 'v' | 'V' | '-' | '_' | '|' | '话' | '話' | '集'
            );
            if !prev_ok || !next_ok {
                continue;
            }
            // 数字后紧跟 "-数字"：范围合集（01-23）
            if followed_by_range {
                return Some(TitleEpisode::Range);
            }
            // 声道（2.0/5.1/7.1）与年份是常见假阳性
            if matches!(num.as_str(), "2.0" | "5.1" | "7.1") {
                continue;
            }
            if prev_word_is_season(&t, start) {
                continue;
            }
            let Ok(v) = num.parse::<f32>() else { continue };
            if v >= 1900.0 {
                continue;
            }
            if v > 0.0 && v < 2000.0 {
                return Some(TitleEpisode::Single(v));
            }
        } else {
            i += 1;
        }
    }
    None
}

/// 主入口：把 MediaMatch 流变成排序后的候选列表（对应 MediaSelectorAutoSelect）。
/// 被排除的候选保留在尾部（可解释），供 UI 展示"为什么被排除"；
/// `MatchKind::Mismatch`（源级"不是这部番"）直接丢弃。
pub fn select_auto(
    matches: Vec<(ani_core::MediaMatch, MediaSourceTier)>,
    req: &MediaFetchRequest,
    pref: &MediaPreference,
    episode_id: Option<EpisodeId>,
) -> Vec<Candidate> {
    let tiers = matches
        .iter()
        .map(|(mm, t)| (mm.media.media_source_id.clone(), *t))
        .collect::<Vec<_>>();
    let ctx = SelectorContext {
        episode: req.episode,
        tiers,
    };
    let mut avail: Vec<Media> = Vec::new();
    let mut excluded: Vec<(Media, ExcludeReason)> = Vec::new();
    for (mm, _) in &matches {
        if mm.match_kind == MatchKind::Mismatch {
            continue;
        }
        let mut media = mm.media.clone();
        media.episode_id = episode_id;
        match exclusion_reason(&media, pref, &ctx) {
            Some(r) => excluded.push((media, r)),
            None => avail.push(media),
        }
    }
    let mut out: Vec<Candidate> = avail
        .into_iter()
        .map(|m| {
            let s = score(&m, pref, &ctx);
            Candidate::Available { media: m, score: s }
        })
        .collect();
    out.sort_by(|a, b| match (a, b) {
        (Candidate::Available { score: sa, .. }, Candidate::Available { score: sb, .. }) => {
            sb.partial_cmp(sa).unwrap_or(std::cmp::Ordering::Equal)
        }
        _ => std::cmp::Ordering::Equal,
    });
    out.extend(
        excluded
            .into_iter()
            .map(|(media, reason)| Candidate::Excluded { media, reason }),
    );
    out
}

/// 取自动选源的最佳候选。
pub fn best_candidate(cands: &[Candidate]) -> Option<&Media> {
    cands.iter().find_map(|c| match c {
        Candidate::Available { media, .. } => Some(media),
        _ => None,
    })
}

/// 偏好学习：用户手选一次 → 更新偏好（对应 MediaSelectorEventSavePreferenceUseCase）。
pub fn learn_preference(mut pref: MediaPreference, picked: &Media) -> MediaPreference {
    if let Some(g) = &picked.properties.subtitle_group {
        pref.subtitle_group = Some(g.clone());
    }
    if let Some(r) = picked.properties.resolution {
        pref.resolution = Some(r);
    }
    pref
}

/// 工具：判断下载类型是否 BT（torrent 源需要先建会话）。
pub fn is_torrent(m: &Media) -> bool {
    matches!(m.download, DownloadKind::Torrent { .. })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ani_core::{MediaKind, MediaProperties, SubjectId};

    fn media(title: &str, group: Option<&str>, height: Option<u32>, src: &str) -> Media {
        Media {
            media_source_id: src.into(),
            title: title.into(),
            kind: MediaKind::FullEpisode,
            episode_id: None,
            properties: MediaProperties {
                resolution: height.map(|h| Resolution {
                    width: h * 16 / 9,
                    height: h,
                }),
                subtitle_group: group.map(String::from),
                ..Default::default()
            },
            download: DownloadKind::Torrent {
                uri: "magnet:?xt=urn:btih:x".into(),
            },
        }
    }

    #[test]
    fn prefers_whitelisted_group() {
        let pref = MediaPreference {
            subtitle_group: Some("LoliHouse".into()),
            ..Default::default()
        };
        let ctx = SelectorContext::default();
        let a = score(
            &media("[LoliHouse] ep1", Some("LoliHouse"), Some(1080), "dmhy"),
            &pref,
            &ctx,
        );
        let b = score(
            &media("[NC-Raws] ep1", Some("NC-Raws"), Some(1080), "dmhy"),
            &pref,
            &ctx,
        );
        assert!(a > b);
    }

    #[test]
    fn blacklisted_is_excluded() {
        let pref = MediaPreference {
            blacklist_groups: ["BadGroup".into()].into_iter().collect(),
            ..Default::default()
        };
        let m = media("[BadGroup] x", Some("BadGroup"), None, "dmhy");
        assert_eq!(
            exclusion_reason(&m, &pref, &SelectorContext::default()),
            Some(ExcludeReason::Blacklisted)
        );
    }

    #[test]
    fn episode_mismatch_excluded() {
        let pref = MediaPreference::default();
        let ctx = SelectorContext {
            episode: Some(5.0),
            tiers: vec![],
        };
        let m = media("[Group] Show - 07 [1080p]", None, None, "dmhy");
        assert_eq!(
            exclusion_reason(&m, &pref, &ctx),
            Some(ExcludeReason::EpisodeMismatch)
        );
    }

    #[test]
    fn title_number_false_positives() {
        // 真实标题里的数字假阳性不能被当成集号
        assert_eq!(
            episode_in_title("[G] Show - 22 [Bilibili WEB-DL 1080P AVC 8bit AAC MP4]"),
            Some(TitleEpisode::Single(22.0))
        );
        assert_eq!(
            episode_in_title("[G] Show [23][1080p][简繁内封]"),
            Some(TitleEpisode::Single(23.0))
        );
        assert_eq!(
            episode_in_title("[G] Show 第07话 [BDRip]"),
            Some(TitleEpisode::Single(7.0))
        );
        assert_eq!(
            episode_in_title("[G] Show [05.5][1080p]"),
            Some(TitleEpisode::Single(5.5))
        );
        assert_eq!(
            episode_in_title("[G] Show [12v2][1080p]"),
            Some(TitleEpisode::Single(12.0))
        );
        assert_eq!(episode_in_title("[G] Show x265 h264 S01 [1080p]"), None);
        assert_eq!(episode_in_title("[G] Show HEVC-10bit AAC 2.0 [720p]"), None);
        assert_eq!(episode_in_title("[G] Movie (2019) [BDRip]"), None);
    }

    #[test]
    fn season_markers_are_not_episodes() {
        // SxxEyy 取 E 后的集号；季号本身（S01/第2季/Season 2）不是集号
        assert_eq!(
            episode_in_title("[LoliHouse] Show S01E05 [1080p]"),
            Some(TitleEpisode::Single(5.0))
        );
        assert_eq!(
            episode_in_title("[LoliHouse] Show S02 E05 [1080p]"),
            Some(TitleEpisode::Single(5.0))
        );
        assert_eq!(episode_in_title("[G] Show 第2季 合集"), None);
        assert_eq!(episode_in_title("[G] Show Season 2 [1080p]"), None);
        assert_eq!(episode_in_title("[G] Show S01 [1080p]"), None);
        // 第N季 + 第N话并存时取话数
        assert_eq!(
            episode_in_title("[G] Show 第2季 第05话"),
            Some(TitleEpisode::Single(5.0))
        );
    }

    #[test]
    fn date_ranges_are_not_episodes() {
        // 年/日期区间既不是范围合集也不是集号
        assert_eq!(episode_in_title("[G] Show 2019-2020 合集 [BDRip]"), None);
        assert_eq!(episode_in_title("[G] Show 2026-08-01 [1080p]"), None);
        // 真范围合集不受影响
        assert_eq!(
            episode_in_title("[LoliHouse] Show [01-23 合集]"),
            Some(TitleEpisode::Range)
        );
    }

    #[test]
    fn range_pack_is_agnostic() {
        // "01-23 合集" 是范围，不该对任何单集报 mismatch
        let pref = MediaPreference::default();
        let ctx = SelectorContext {
            episode: Some(22.0),
            tiers: vec![],
        };
        let m = media(
            "[LoliHouse] Show [01-23 合集][WebRip 1080p HEVC-10bit AAC][Fin]",
            None,
            None,
            "dmhy",
        );
        assert_eq!(episode_in_title(&m.title), Some(TitleEpisode::Range));
        assert_eq!(exclusion_reason(&m, &pref, &ctx), None);
    }

    #[test]
    fn mp4_never_counts_as_episode() {
        // 回归：从 "MP4" 抠出 4 导致 "- 22" 被误判（线上截图案例）
        let pref = MediaPreference::default();
        let ctx = SelectorContext {
            episode: Some(22.0),
            tiers: vec![],
        };
        let m = media(
            "[Prejudice-Studio] Show - 22 [Bilibili WEB-DL 1080P AVC 8bit AAC MP4][简日内嵌]",
            None,
            None,
            "dmhy",
        );
        assert_eq!(episode_in_title(&m.title), Some(TitleEpisode::Single(22.0)));
        assert_eq!(exclusion_reason(&m, &pref, &ctx), None);
    }

    #[test]
    fn sorting_puts_best_first() {
        let req = MediaFetchRequest {
            episode: Some(1.0),
            ..Default::default()
        };
        let matches = vec![
            (
                ani_core::MediaMatch {
                    media: media("[NC-Raws] S1 - 01", Some("NC-Raws"), Some(720), "dmhy"),
                    match_kind: MatchKind::Fuzzy,
                },
                MediaSourceTier::Low,
            ),
            (
                ani_core::MediaMatch {
                    media: media(
                        "[LoliHouse] S1 - 01",
                        Some("LoliHouse"),
                        Some(1080),
                        "mikan",
                    ),
                    match_kind: MatchKind::Fuzzy,
                },
                MediaSourceTier::Medium,
            ),
        ];
        let pref = MediaPreference {
            subtitle_group: Some("LoliHouse".into()),
            ..Default::default()
        };
        let cands = select_auto(matches, &req, &pref, None);
        let first = best_candidate(&cands).unwrap();
        assert!(first.title.contains("LoliHouse"));
    }

    #[test]
    fn learn() {
        let pref = learn_preference(
            MediaPreference::default(),
            &media("x", Some("AB"), Some(1080), "dmhy"),
        );
        assert_eq!(pref.subtitle_group.as_deref(), Some("AB"));
        assert_eq!(pref.resolution.unwrap().height, 1080);
    }

    #[test]
    fn subject_id_unused() {
        // 保持对 ani-core 的引用面稳定
        let _ = SubjectId(1);
    }
}
