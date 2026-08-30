//! 弹幕引擎（对应 Ani `danmaku:*` 的引擎层 + dandanplay 协议层）。
//!
//! 职责（蓝图 3.5）：合并去重（多源）→ 屏蔽（关键词/用户）→ 按时间轴分桶索引。
//! 后端负责"什么时候显示什么"，前端只管画——渲染层零过滤逻辑。
//! 协议层：`dandanplay` 模块（开放 API，AppId/Secret 在设置页配置）。

pub mod dandanplay;

use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DanmakuMode {
    Scroll,
    Top,
    Bottom,
    Reverse,
}

/// 一条弹幕事件（跨前后端类型）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DanmakuEvent {
    pub time_ms: i64,
    pub mode: DanmakuMode,
    /// RGB
    pub color: u32,
    pub sender: Option<String>,
    pub text: String,
    /// 权重低的高峰期先丢
    pub weight: u8,
}

/// 屏蔽设置（对应 danmaku-ui-config）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DanmakuFilter {
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default)]
    pub blocked_users: Vec<String>,
    #[serde(default)]
    pub hide_scroll: bool,
    #[serde(default)]
    pub hide_top_bottom: bool,
}

impl DanmakuFilter {
    pub fn allows(&self, d: &DanmakuEvent) -> bool {
        if self.hide_scroll && d.mode == DanmakuMode::Scroll {
            return false;
        }
        if self.hide_top_bottom && matches!(d.mode, DanmakuMode::Top | DanmakuMode::Bottom) {
            return false;
        }
        if let Some(s) = &d.sender {
            if self.blocked_users.iter().any(|u| u == s) {
                return false;
            }
        }
        let t = d.text.to_lowercase();
        // 空关键词会让 contains 恒真（屏蔽一切），过滤掉
        if self
            .keywords
            .iter()
            .any(|k| !k.trim().is_empty() && t.contains(&k.to_lowercase()))
        {
            return false;
        }
        true
    }
}

/// 时间轴分桶索引（桶宽 1s），构建时按 weight 降序。
/// 播放器 time-pos 更新时 O(1) 重定位，seek 后同样 O(1)。
pub struct DanmakuIndex {
    /// start_ms/1000 → 该秒内要上屏的弹幕
    buckets: Vec<Vec<Arc<DanmakuEvent>>>,
    bucket_width_ms: i64,
}

/// 弹幕时间上限：超过视为脏数据丢弃（防止 time_ms 无界把分桶撑爆）。
const MAX_TIME_MS: i64 = 24 * 60 * 60 * 1000;

impl DanmakuIndex {
    /// 从（已去重、已过滤的）弹幕构建索引。
    pub fn build(events: Vec<DanmakuEvent>, filter: &DanmakuFilter) -> Self {
        // 弹幕来自第三方接口，time_ms 必须双向校验：负值与超 24h 的脏数据都会
        // 破坏分桶（前者下溢，后者把 buckets 撑到 OOM）
        let mut kept: Vec<DanmakuEvent> = events
            .into_iter()
            .filter(|d| d.time_ms >= 0 && d.time_ms <= MAX_TIME_MS && filter.allows(d))
            .collect();
        kept.sort_by_key(|d| d.time_ms);

        let bucket_width_ms = 1000;
        let mut buckets: Vec<Vec<Arc<DanmakuEvent>>> = Vec::new();
        for d in kept {
            let idx = (d.time_ms / bucket_width_ms) as usize;
            while buckets.len() <= idx {
                buckets.push(Vec::new());
            }
            buckets[idx].push(Arc::new(d));
        }
        // 每桶内按 weight 降序：高峰期截断时先保住高质量弹幕
        for b in &mut buckets {
            b.sort_by_key(|e| std::cmp::Reverse(e.weight));
        }
        Self {
            buckets,
            bucket_width_ms,
        }
    }

    /// [from_ms, to_ms) 窗口内的弹幕。
    pub fn window(&self, from_ms: i64, to_ms: i64) -> impl Iterator<Item = &Arc<DanmakuEvent>> {
        let lo = (from_ms / self.bucket_width_ms).max(0);
        let hi = ((to_ms / self.bucket_width_ms) + 1).max(lo);
        let lo = lo as usize;
        let hi = hi as usize;
        self.buckets
            .iter()
            .enumerate()
            .skip_while(move |(i, _)| *i < lo)
            .take_while(move |(i, _)| *i <= hi)
            .flat_map(|(_, b)| b.iter())
            .filter(move |d| d.time_ms >= from_ms && d.time_ms < to_ms)
    }

    pub fn len(&self) -> usize {
        self.buckets.iter().map(|b| b.len()).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// 多源合并去重：同 sender+text+time（±500ms）视为同一条。
/// 输入按时间升序，去重只需回看 500ms 窗口内的尾部（O(n·w) 而非 O(n²)）。
pub fn merge_dedup(mut sources: Vec<Vec<DanmakuEvent>>) -> Vec<DanmakuEvent> {
    let mut all: Vec<DanmakuEvent> = sources.drain(..).flatten().collect();
    all.sort_by_key(|d| d.time_ms);
    let mut out: Vec<DanmakuEvent> = Vec::new();
    for d in all {
        let dup = out
            .iter()
            .rev()
            .take_while(|e| d.time_ms - e.time_ms <= 500)
            .any(|e| e.text == d.text && e.sender == d.sender);
        if !dup {
            out.push(d);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(t: i64, text: &str) -> DanmakuEvent {
        DanmakuEvent {
            time_ms: t,
            mode: DanmakuMode::Scroll,
            color: 0xffffff,
            sender: None,
            text: text.into(),
            weight: 5,
        }
    }

    #[test]
    fn filter_blocks_keywords() {
        let f = DanmakuFilter {
            keywords: vec!["广告".into()],
            ..Default::default()
        };
        assert!(!f.allows(&d(1000, "这是广告内容")));
        assert!(f.allows(&d(1000, "好耶")));
    }

    #[test]
    fn window_and_buckets() {
        let idx = DanmakuIndex::build(
            vec![d(500, "a"), d(1500, "b"), d(1600, "c")],
            &DanmakuFilter::default(),
        );
        assert_eq!(idx.len(), 3);
        let w: Vec<_> = idx.window(1000, 2000).collect();
        assert_eq!(w.len(), 2);
        assert!(w.iter().all(|e| e.text != "a"));
    }

    #[test]
    fn dedup() {
        let merged = merge_dedup(vec![
            vec![d(1000, "hi")],
            vec![d(1200, "hi"), d(5000, "yo")],
        ]);
        assert_eq!(merged.len(), 2);
    }
}
