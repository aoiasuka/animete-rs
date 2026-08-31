//! ani-torrent —— BT 引擎封装（librqbit 8，纯 Rust，对应 Ani 的 anitorrent）。
//!
//! 关键设计（蓝图 3.3）：
//! - 会话持久化交给 librqbit 自己落盘，SQLite 里只存活跃种子清单（单一真相源原则）
//! - 下载目录默认 %APPDATA%/ani-rs/downloads
//! - 边下边播：librqbit 的 [`open_stream`] 返回 AsyncRead + AsyncSeek 的文件流，
//!   读到未下载 piece 会阻塞等待，且 session 按所有活跃流的当前位置交错提升
//!   piece 下载优先级（seek 即改读位置，优先级随动）——对应 Ani 的 torrent/io
//!   StreamingReader；上层经 anibt:// 协议把该流喂给应用内播放器

use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TorrentSessionOptions {
    pub download_dir: PathBuf,
    /// 做种开关（默认开启回馈 swarm；退出时 UI 给"正在做种 N 个"的挽留提示）
    pub seeding: bool,
    /// 监听端口（0 = 系统分配）
    pub listen_port: u16,
}

impl Default for TorrentSessionOptions {
    fn default() -> Self {
        let download_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("ani-rs")
            .join("downloads");
        Self {
            download_dir,
            seeding: true,
            listen_port: 4242,
        }
    }
}

pub type ManagedTorrentHandle = std::sync::Arc<librqbit::ManagedTorrent>;

/// 封装 librqbit Session。
pub struct TorrentSession {
    session: std::sync::Arc<librqbit::Session>,
    opts: TorrentSessionOptions,
}

impl TorrentSession {
    pub async fn new(opts: TorrentSessionOptions) -> anyhow::Result<Self> {
        tokio::fs::create_dir_all(&opts.download_dir).await.ok();
        // 端口区间避免 u16 溢出（用户可配置到 65535）
        let port_range = (opts.listen_port != 0)
            .then(|| opts.listen_port..opts.listen_port.saturating_add(20).max(opts.listen_port));
        // fastresume + session 持久化：重启后自动恢复任务与断点（单一真相源在 librqbit，
        // SQLite 只存播放进度等业务数据——蓝图 3.3 的原则）
        let so = librqbit::SessionOptions {
            listen_port_range: port_range,
            fastresume: true,
            persistence: Some(librqbit::SessionPersistenceConfig::Json { folder: None }),
            ..Default::default()
        };
        let session = librqbit::Session::new_with_opts(opts.download_dir.clone(), so)
            .await
            .context("failed to start torrent session")?;
        Ok(Self { session, opts })
    }

    pub fn options(&self) -> &TorrentSessionOptions {
        &self.opts
    }

    /// 内部 librqbit 会话（暂停/恢复等未封装能力走这里）。
    pub fn inner(&self) -> &std::sync::Arc<librqbit::Session> {
        &self.session
    }

    /// 加入磁力/.torrent URL，返回句柄。
    ///
    /// 注意：磁力链接的 `add_torrent` 会阻塞到元数据从 peer 处解析完成
    /// （librqbit 8 的行为），调用方需要自己加超时（command 层已包）。
    /// 文件固定落在 `download_dir/<种子内相对路径>`（显式 output_folder，
    /// 不让 librqbit 给多文件种子自动加种子名子目录，command 层的路径拼装依赖这一点）。
    pub async fn add(&self, uri: &str) -> anyhow::Result<ManagedTorrentHandle> {
        let opts = librqbit::AddTorrentOptions {
            paused: false,
            output_folder: Some(self.opts.download_dir.to_string_lossy().into_owned()),
            ..Default::default()
        };
        let added = self
            .session
            .add_torrent(librqbit::AddTorrent::from_url(uri), Some(opts))
            .await
            .context("add_torrent failed")?;
        let handle = added
            .into_handle()
            .context("torrent is list-only (unexpected)")?;
        // 重复添加已存在的种子时 librqbit 返回 AlreadyManaged 并忽略 paused:false，
        // 句柄可能处于 Paused 状态（如之前被 remove 过），这里恢复到下载中
        if matches!(handle.stats().state, librqbit::TorrentStatsState::Paused) {
            self.session.unpause(&handle).await.ok();
        }
        Ok(handle)
    }

    /// 等待元数据就绪（磁力元数据阶段没有文件列表，等事件而不是轮询——蓝图 13.2 坑 12）。
    pub async fn wait_metadata(
        &self,
        handle: &ManagedTorrentHandle,
        timeout: std::time::Duration,
    ) -> anyhow::Result<()> {
        tokio::time::timeout(timeout, async {
            loop {
                let resolved = handle.with_metadata(|_| ()).is_ok();
                if resolved {
                    return Ok::<(), anyhow::Error>(());
                }
                if handle.live().is_none() {
                    anyhow::bail!("torrent not live");
                }
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
        })
        .await
        .context("timed out waiting for torrent metadata")??;
        Ok(())
    }

    /// 列出种子内文件（需元数据就绪）。
    pub fn list_files(handle: &ManagedTorrentHandle) -> anyhow::Result<Vec<TorrentFileEntry>> {
        handle.with_metadata(|meta| {
            meta.file_infos
                .iter()
                .enumerate()
                .map(|(index, f)| TorrentFileEntry {
                    index,
                    name: f.relative_filename.to_string_lossy().into_owned(),
                    offset_in_torrent: f.offset_in_torrent,
                    length: f.len,
                    // librqbit 的 piece_range 是排他区间（end = ceil），转成文档约定的闭区间
                    piece_range: f.piece_range.start as usize
                        ..=(f.piece_range.end.max(1) - 1) as usize,
                })
                .collect()
        })
    }

    /// 播放器 seek 的核心一跳：把字节偏移换算成 piece 闭区间（对应 TorrentFilePieceMatcher）。
    pub fn pieces_for_range(
        file: &TorrentFileEntry,
        offset: u64,
        len: u64,
        piece_len: u64,
    ) -> (u64, u64) {
        let piece_len = piece_len.max(1);
        let abs = file.offset_in_torrent + offset;
        (
            abs / piece_len,
            // 末字节所在 piece（闭区间），与 TorrentFileEntry::piece_range 语义一致
            (abs + len.max(1) - 1) / piece_len,
        )
    }

    /// 打开种子内文件的流式读取器（需元数据就绪、种子处于下载/暂停状态）。
    ///
    /// librqbit 未导出 `FileStream` 具体类型，这里以 `impl Trait` 透传：
    /// `AsyncRead` 读到未下载 piece 时阻塞等待（piece 到位后唤醒），
    /// `AsyncSeek` 改读位置即改变下载优先级队列的起点。
    pub fn open_stream(
        handle: &ManagedTorrentHandle,
        file_index: usize,
    ) -> anyhow::Result<impl tokio::io::AsyncRead + tokio::io::AsyncSeek + Unpin + Send> {
        handle.clone().stream(file_index)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TorrentFileEntry {
    pub index: usize,
    pub name: String,
    pub offset_in_torrent: u64,
    pub length: u64,
    /// 覆盖的 piece 索引闭区间
    pub piece_range: std::ops::RangeInclusive<usize>,
}

/// 下载进度摘要（发给前端 `download-progress` 事件，对应 PieceSubscribable 的位图摘要）。
#[derive(Debug, Clone, Serialize)]
pub struct TorrentStatsSummary {
    pub progress_bytes: u64,
    pub total_bytes: u64,
    pub finished: bool,
    pub download_speed_bps: f64,
    pub upload_speed_bps: f64,
}

pub fn stats_summary(handle: &ManagedTorrentHandle) -> TorrentStatsSummary {
    let stats = handle.stats();
    TorrentStatsSummary {
        progress_bytes: stats.progress_bytes,
        total_bytes: stats.total_bytes,
        finished: stats.finished,
        download_speed_bps: stats
            .live
            .as_ref()
            .map(|l| l.download_speed.mbps * 1_048_576.0)
            .unwrap_or(0.0),
        upload_speed_bps: stats
            .live
            .as_ref()
            .map(|l| l.upload_speed.mbps * 1_048_576.0)
            .unwrap_or(0.0),
    }
}
