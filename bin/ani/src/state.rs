//! 装配层（对应 Ani 的 DesktopModulesKt）：全部依赖在此显式构造。

use std::sync::Arc;

use ani_core::MediaSourceRegistry;
use ani_torrent::TorrentSession;
use ds_bangumi::BangumiSource;
use sqlx::SqlitePool;
use tokio::sync::OnceCell;

use crate::settings::SettingsData;

/// 一个活跃下载任务。
pub struct DownloadTask {
    /// info-hash hex
    pub id: String,
    pub title: String,
    pub handle: ani_torrent::ManagedTorrentHandle,
}

pub struct AppContext {
    pub bgm: BangumiSource,
    pub registry: MediaSourceRegistry,
    /// 数据库连接池（进度/收藏等持久化在 M4 接入 command 层）
    #[allow(dead_code)]
    pub db: SqlitePool,
    /// 设置（内存为准，save_settings 时同步落盘）
    pub settings: std::sync::RwLock<SettingsData>,
    /// 活跃下载任务（多任务管理）
    pub downloads: std::sync::Mutex<Vec<DownloadTask>>,
    /// 进度 ticker 单例标志（防止重复 spawn 导致事件翻倍）
    pub ticker_running: std::sync::atomic::AtomicBool,
    /// 最近一次成功注册进 registry 的 Jellyfin 配置（保存设置时判断是否需要重建）
    pub jellyfin_applied: std::sync::Mutex<Option<ds_jellyfin::JellyfinConfig>>,
    /// BT 会话懒加载（首次点"下载"才建立，避免启动变慢）
    pub torrent: OnceCell<Arc<TorrentSession>>,
}

impl AppContext {
    pub async fn build() -> anyhow::Result<Self> {
        let bgm = BangumiSource::new()?;
        let registry = MediaSourceRegistry::new();
        registry.register(Arc::new(ds_dmhy::DmhySource::new()?));
        registry.register(Arc::new(ds_mikan::MikanSource::new()?));
        registry.register(Arc::new(ds_acgrip::AcgRipSource::new()?));
        registry.register(Arc::new(ds_nyaa::NyaaSource::new()?));
        let db = ani_db::open(&ani_db::default_db_path()).await?;

        let settings = SettingsData::load();
        let mut jellyfin_applied = None;
        // Jellyfin：配置了服务器才作为源出现
        if settings.jellyfin.is_configured() {
            match ds_jellyfin::JellyfinSource::connect(&settings.jellyfin.to_config()).await {
                Ok(src) => {
                    jellyfin_applied = Some(settings.jellyfin.to_config());
                    registry.register(Arc::new(src));
                }
                Err(e) => tracing::warn!("jellyfin connect failed, source disabled: {e}"),
            }
        }
        // 应用数据源启停
        for info in registry.list_info() {
            registry.set_enabled(&info.id, settings.source_enabled(&info.id));
        }

        Ok(Self {
            bgm,
            registry,
            db,
            settings: std::sync::RwLock::new(settings),
            downloads: std::sync::Mutex::new(Vec::new()),
            ticker_running: std::sync::atomic::AtomicBool::new(false),
            jellyfin_applied: std::sync::Mutex::new(jellyfin_applied),
            torrent: OnceCell::const_new(),
        })
    }

    /// 生效中的下载目录（设置里为空则用默认值）。
    pub fn effective_download_dir(&self) -> std::path::PathBuf {
        let st = self.settings.read().unwrap();
        if st.torrent.download_dir.trim().is_empty() {
            dirs::data_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join("ani-rs")
                .join("downloads")
        } else {
            std::path::PathBuf::from(st.torrent.download_dir.trim())
        }
    }

    pub async fn torrent_session(&self) -> anyhow::Result<Arc<TorrentSession>> {
        let s = self
            .torrent
            .get_or_try_init(|| async {
                let opts = {
                    let st = self.settings.read().unwrap();
                    ani_torrent::TorrentSessionOptions {
                        download_dir: self.effective_download_dir(),
                        seeding: st.torrent.seeding,
                        listen_port: st.torrent.listen_port,
                    }
                };
                let s = TorrentSession::new(opts).await?;
                // librqbit fastresume 恢复的历史任务登记进下载面板，
                // 否则它们继续占带宽却既看不到也管不了
                let restored = s
                    .inner()
                    .with_torrents(|ts| ts.map(|(_, t)| t.clone()).collect::<Vec<_>>());
                let mut list = self.downloads.lock().unwrap();
                for h in restored {
                    let id = h.info_hash().as_string();
                    if list.iter().any(|t| t.id == id) {
                        continue;
                    }
                    let title = h.name().unwrap_or_default();
                    list.push(DownloadTask {
                        id,
                        title,
                        handle: h,
                    });
                }
                drop(list);
                anyhow::Ok(Arc::new(s))
            })
            .await?;
        Ok(s.clone())
    }
}
