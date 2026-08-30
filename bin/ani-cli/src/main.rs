//! ani-cli —— M0/M1 验收入口（对应蓝图 4.4 的 M0 起步代码，扩展到多源聚合选源）。
//!
//! 用法：
//!   ani-cli search <关键词>            # Bangumi 搜条目
//!   ani-cli episodes <subject_id>      # 列剧集
//!   ani-cli fetch <subject_id> [ep]    # 多源聚合 + 自动选源，列出候选
//!   ani-cli best <subject_id> <ep>     # 只打印最佳候选
//!   ani-cli db                         # 初始化/检查本地 SQLite

use ani_core::{MediaFetchRequest, MediaSourceRegistry};
use anyhow::{bail, Context, Result};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "warn,ani_cli=info".into()),
        )
        .init();

    let mut args = std::env::args().skip(1);
    let Some(cmd) = args.next() else {
        print_usage();
        return Ok(());
    };

    match cmd.as_str() {
        "search" => {
            let kw = args.next().context("需要关键词")?;
            let bgm = ds_bangumi::BangumiSource::new()?;
            for s in bgm.search(&kw).await? {
                println!(
                    "#{:<8} {:<10} {}",
                    s.id.0,
                    s.air_date.as_deref().unwrap_or("----"),
                    s.display_title
                );
            }
        }
        "episodes" => {
            let id: u32 = args.next().context("需要 subject_id")?.parse()?;
            let bgm = ds_bangumi::BangumiSource::new()?;
            for e in bgm.episodes(ani_core::SubjectId(id)).await? {
                println!("  {:>5.1}  [{:?}]  {}", e.ep, e.kind, e.display_title);
            }
        }
        "fetch" | "best" => {
            let id: u32 = args.next().context("需要 subject_id")?.parse()?;
            // 集号解析失败要报错，静默当 None 会退化成"聚合整季"
            let ep: Option<f32> = match args.next() {
                Some(s) => Some(s.parse().with_context(|| format!("无效集号：{s}"))?),
                None => None,
            };
            run_select(id, ep, cmd == "best").await?;
        }
        "db" => {
            let pool = ani_db::open(&ani_db::default_db_path()).await?;
            let repo = ani_db::PlaybackRepo::new(pool);
            println!("db ok at {:?}", ani_db::default_db_path());
            println!(
                "history row 1: {:?}",
                repo.load_position(ani_core::EpisodeId(1)).await?
            );
        }
        "torrent" => {
            // 烟雾测试：建立会话（不实际添加种子）
            let s = ani_torrent::TorrentSession::new(Default::default()).await?;
            println!("torrent session ok, dir={:?}", s.options().download_dir);
        }
        _ => print_usage(),
    }
    Ok(())
}

async fn run_select(subject_id: u32, ep: Option<f32>, only_best: bool) -> Result<()> {
    let bgm = ds_bangumi::BangumiSource::new()?;

    // 1) 条目与剧集元数据
    let subject = bgm
        .subject_detail(ani_core::SubjectId(subject_id))
        .await
        .context("bangumi subject failed")?;
    let episodes = bgm.episodes(ani_core::SubjectId(subject_id)).await?;
    let episode = ep.and_then(|ep| episodes.iter().find(|e| (e.ep - ep).abs() < 0.01).cloned());

    // 2) 构造选源请求（中文优先 + 原名别名）
    let req = MediaFetchRequest {
        subject_name: subject.display_title.clone(),
        aliases: vec![subject.original_title.clone()],
        subject_id: Some(subject_id),
        episode: ep,
        season: None,
        year: subject
            .air_date
            .as_deref()
            .and_then(|d| d.get(..4))
            .and_then(|y| y.parse().ok()),
        episode_title: episode.as_ref().map(|e| e.display_title.clone()),
    };

    // 3) 并发聚合 dmhy + mikan（单源失败不拖垮整体）
    let registry = MediaSourceRegistry::new();
    registry.register(std::sync::Arc::new(ds_dmhy::DmhySource::new()?));
    registry.register(std::sync::Arc::new(ds_mikan::MikanSource::new()?));
    registry.register(std::sync::Arc::new(ds_acgrip::AcgRipSource::new()?));
    registry.register(std::sync::Arc::new(ds_nyaa::NyaaSource::new()?));

    eprintln!(
        "检索：{}（ep {ep:?}），关键词 {:?} ...",
        req.subject_name, req.subject_name
    );
    let results = registry.fetch_all(&req).await;

    // 4) 汇总 + 评分（episode_id 关联）
    let mut matches = Vec::new();
    for (src, r) in results {
        match r {
            Ok(ms) => {
                eprintln!("  [{src}] {} 条", ms.len());
                for mm in ms {
                    matches.push((mm, tier_of(src.as_str())));
                }
            }
            Err(e) => eprintln!("  [{src}] 失败：{e}"),
        }
    }
    if matches.is_empty() {
        bail!("没有候选结果（网络或站点问题，可稍后重试）");
    }

    let cands = ani_domain::select_auto(
        matches,
        &req,
        &ani_domain::MediaPreference::default(),
        episode.as_ref().map(|e| e.id),
    );

    if only_best {
        match ani_domain::best_candidate(&cands) {
            Some(m) => {
                println!("{}", serde_json::to_string_pretty(m)?);
            }
            None => bail!("无可用候选"),
        }
    } else {
        for (i, c) in cands.iter().take(30).enumerate() {
            let m = c.media();
            match c {
                ani_core::Candidate::Available { score, .. } => println!(
                    "{:>2}. [{:>4.1}] {} ({}) [{:?}] {}",
                    i + 1,
                    score,
                    m.media_source_id,
                    m.properties.subtitle_group.as_deref().unwrap_or("?"),
                    m.properties.resolution.map(|r| r.height).unwrap_or(0),
                    m.title
                ),
                ani_core::Candidate::Excluded { reason, .. } => println!(
                    "{:>2}. [排除:{reason:?}] {} - {}",
                    i + 1,
                    m.media_source_id,
                    m.title
                ),
            }
        }
    }
    Ok(())
}

fn tier_of(source_id: &str) -> ani_core::MediaSourceTier {
    match source_id {
        "dmhy" => ani_core::MediaSourceTier::Medium,
        "mikan" => ani_core::MediaSourceTier::Medium,
        "bangumi" => ani_core::MediaSourceTier::High,
        _ => ani_core::MediaSourceTier::Low,
    }
}

fn print_usage() {
    eprintln!(
        "用法:\n  ani-cli search <关键词>\n  ani-cli episodes <subject_id>\n  ani-cli fetch <subject_id> [ep]\n  ani-cli best <subject_id> <ep>\n  ani-cli db\n  ani-cli torrent"
    );
}
