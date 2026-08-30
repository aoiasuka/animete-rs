//! Tauri command 层（对应蓝图 4.3）：前端 ↔ Rust 的边界，保持薄。
//! 业务都在 ani-domain / ds-* 里，这里只做装配与转发。

use crate::settings::SettingsData;
use crate::state::AppContext;
use ani_core::{Episode, MediaFetchRequest, MediaSourceInfo, SubjectSummary};
use tauri::{AppHandle, Emitter, State};

#[derive(serde::Serialize)]
pub struct MediaSelection {
    pub subject: SubjectSummary,
    pub episode: Option<Episode>,
    pub candidates: Vec<ani_core::Candidate>,
    pub source_errors: Vec<String>,
}

#[derive(serde::Serialize)]
pub struct GetSettingsResp {
    pub settings: SettingsData,
    pub sources: Vec<MediaSourceInfo>,
    pub paths: std::collections::HashMap<String, String>,
}

#[tauri::command]
pub async fn search_subjects(
    ctx: State<'_, AppContext>,
    q: String,
) -> Result<Vec<SubjectSummary>, String> {
    let r = ctx.bgm.search(&q).await.map_err(|e| e.to_string())?;
    // 记录搜索历史（首页「最近搜索」），失败不影响搜索本身
    let repo = ani_db::SearchHistoryRepo::new(ctx.db.clone());
    if let Err(e) = repo.record(&q).await {
        tracing::warn!("record search history failed: {e}");
    }
    Ok(r)
}

/// 本周新番时间表（首页）。
#[tauri::command]
pub async fn get_calendar(
    ctx: State<'_, AppContext>,
) -> Result<Vec<ds_bangumi::CalendarDay>, String> {
    ctx.bgm.calendar().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_search_history(ctx: State<'_, AppContext>) -> Result<Vec<String>, String> {
    ani_db::SearchHistoryRepo::new(ctx.db.clone())
        .list(12)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clear_search_history(ctx: State<'_, AppContext>) -> Result<(), String> {
    ani_db::SearchHistoryRepo::new(ctx.db.clone())
        .clear()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn episode_list(
    ctx: State<'_, AppContext>,
    subject_id: u32,
) -> Result<Vec<Episode>, String> {
    ctx.bgm
        .episodes(ani_core::SubjectId(subject_id))
        .await
        .map_err(|e| e.to_string())
}

/// 向所有启用源并发检索 + 自动选源（对应 domain/media/fetch + MediaSelectorAutoSelect）。
#[tauri::command]
pub async fn fetch_medias(
    ctx: State<'_, AppContext>,
    subject_id: u32,
    ep: Option<f32>,
) -> Result<MediaSelection, String> {
    let subject = ctx
        .bgm
        .subject_detail(ani_core::SubjectId(subject_id))
        .await
        .map_err(|e| e.to_string())?;
    let episodes = ctx
        .bgm
        .episodes(ani_core::SubjectId(subject_id))
        .await
        .map_err(|e| e.to_string())?;
    let episode = ep.and_then(|ep| episodes.iter().find(|e| (e.ep - ep).abs() < 0.01).cloned());

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

    // 用户覆盖的源优先级（设置页可调），参与选源评分
    let tier_over: std::collections::HashMap<String, String> = {
        let st = ctx.settings.read().unwrap();
        st.sources
            .iter()
            .filter_map(|s| s.tier.clone().map(|t| (s.id.clone(), t)))
            .collect()
    };
    let results = ctx.registry.fetch_all(&req).await;
    let mut matches = Vec::new();
    let mut source_errors = Vec::new();
    for (src, r) in results {
        let tier = tier_over
            .get(src.as_str())
            .map(|t| parse_tier(t))
            .unwrap_or_else(|| tier_of(&src));
        match r {
            Ok(ms) => {
                for mm in ms {
                    matches.push((mm, tier));
                }
            }
            Err(e) => source_errors.push(format!("{src}: {e}")),
        }
    }
    // 选源偏好来自设置界面（对应 MediaSelectorSubtitlePreferences）
    let pref = ctx.settings.read().unwrap().selector.clone();
    let candidates = ani_domain::select_auto(matches, &req, &pref, episode.as_ref().map(|e| e.id));
    Ok(MediaSelection {
        subject,
        episode,
        candidates,
        source_errors,
    })
}

/// 下载进度摘要（多任务聚合广播的元素）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct DownloadProgress {
    pub id: String,
    pub title: String,
    pub paused: bool,
    pub finished: bool,
    pub progress_bytes: u64,
    pub total_bytes: u64,
    pub download_speed_bps: f64,
    pub upload_speed_bps: f64,
}

fn snapshot_task(t: &crate::state::DownloadTask) -> DownloadProgress {
    let st = t.handle.stats();
    DownloadProgress {
        id: t.id.clone(),
        title: t.title.clone(),
        paused: t.handle.live().is_none() && !st.finished,
        finished: st.finished,
        progress_bytes: st.progress_bytes,
        total_bytes: st.total_bytes,
        download_speed_bps: st
            .live
            .as_ref()
            .map(|l| l.download_speed.mbps * 1_048_576.0)
            .unwrap_or(0.0),
        upload_speed_bps: st
            .live
            .as_ref()
            .map(|l| l.upload_speed.mbps * 1_048_576.0)
            .unwrap_or(0.0),
    }
}

/// 任务登记（去重）+ 启动全局进度 ticker（ticker_running 防重复 spawn）。
fn register_download(
    app: &AppHandle,
    ctx: &AppContext,
    handle: ani_torrent::ManagedTorrentHandle,
    title: String,
) -> String {
    let id = handle.info_hash().as_string();
    {
        let mut list = ctx.downloads.lock().unwrap();
        match list.iter_mut().find(|t| t.id == id) {
            Some(t) => {
                if !title.is_empty() {
                    t.title = title;
                }
            }
            None => list.push(crate::state::DownloadTask {
                id: id.clone(),
                title,
                handle,
            }),
        }
    }
    ensure_ticker(app, ctx);
    id
}

/// 有任务就保证 ticker 在跑（幂等）：任务登记与面板打开都会调用。
fn ensure_ticker(app: &AppHandle, ctx: &AppContext) {
    let has_tasks = !ctx.downloads.lock().unwrap().is_empty();
    if has_tasks
        && !ctx
            .ticker_running
            .swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        tauri::async_runtime::spawn(download_ticker(app.clone()));
    }
}

/// 全局进度广播：每 800ms 汇总所有任务 emit `downloads-progress`；列表空则退出。
/// 退出前做双重检查（复位 ticker_running 后再确认列表），避免与并发注册的竞态漏启动。
async fn download_ticker(app: AppHandle) {
    use tauri::Manager;
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        let payload = {
            let ctx = app.state::<AppContext>();
            let list = ctx.downloads.lock().unwrap();
            list.iter().map(snapshot_task).collect::<Vec<_>>()
        };
        let empty = payload.is_empty();
        let _ = app.emit("downloads-progress", &payload);
        if empty {
            let ctx = app.state::<AppContext>();
            ctx.ticker_running
                .store(false, std::sync::atomic::Ordering::SeqCst);
            let drained = ctx.downloads.lock().unwrap().is_empty();
            if drained
                || ctx
                    .ticker_running
                    .swap(true, std::sync::atomic::Ordering::SeqCst)
            {
                return;
            }
        }
    }
}

/// 开始 BT 下载（磁力/.torrent URL），登记任务后由全局 ticker 广播进度。
#[tauri::command]
pub async fn start_torrent(
    app: AppHandle,
    ctx: State<'_, AppContext>,
    uri: String,
    title: Option<String>,
) -> Result<String, String> {
    let session = ctx.torrent_session().await.map_err(|e| e.to_string())?;
    // 磁力链接的 add 会阻塞到元数据从 peer 解析完成（librqbit 8 行为），
    // 死种/慢 swarm 时可无限挂起，必须包超时
    let handle = tokio::time::timeout(std::time::Duration::from_secs(120), session.add(&uri))
        .await
        .map_err(|_| "连接 swarm 超时：获取种子元数据失败（网络或做种人数不足）".to_string())?
        .map_err(|e| e.to_string())?;
    let id = register_download(&app, &ctx, handle.clone(), title.unwrap_or_default());

    // 元数据就绪后把文件列表发给前端（等事件而不是轮询——蓝图 13.2 坑 12）
    {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = session
                .wait_metadata(&handle, std::time::Duration::from_secs(120))
                .await
            {
                tracing::warn!("torrent metadata timeout: {e}");
                return;
            }
            match ani_torrent::TorrentSession::list_files(&handle) {
                Ok(files) => {
                    let _ = app.emit("torrent-files", &files);
                }
                Err(e) => tracing::warn!("list files failed: {e}"),
            }
        });
    }
    Ok(id)
}

/// 当前任务列表（前端打开面板/刷新用）；打开面板同时保证 ticker 在跑
/// （覆盖 librqbit fastresume 恢复、未经 register_download 的任务）。
#[tauri::command]
pub fn list_downloads(app: AppHandle) -> Vec<DownloadProgress> {
    use tauri::Manager;
    let ctx = app.state::<AppContext>();
    let payload = {
        let list = ctx.downloads.lock().unwrap();
        list.iter().map(snapshot_task).collect::<Vec<_>>()
    };
    if !payload.is_empty() {
        ensure_ticker(&app, &ctx);
    }
    payload
}

/// 暂停 / 恢复任务。
#[tauri::command]
pub async fn set_download_paused(
    ctx: State<'_, AppContext>,
    id: String,
    paused: bool,
) -> Result<(), String> {
    let handle = {
        let list = ctx.downloads.lock().unwrap();
        list.iter().find(|t| t.id == id).map(|t| t.handle.clone())
    };
    let Some(handle) = handle else {
        return Err("任务不存在".into());
    };
    let session = ctx.torrent_session().await.map_err(|e| e.to_string())?;
    if paused {
        session.inner().pause(&handle).await
    } else {
        session.inner().unpause(&handle).await
    }
    .map_err(|e| e.to_string())
}

/// 移除任务：先 pause 成功再移出列表；delete_files=true 时同时从磁盘删除文件并
/// 从 librqbit 会话中彻底移除（否则重启后 fastresume 会恢复为 paused 任务）。
#[tauri::command]
pub async fn remove_download(
    ctx: State<'_, AppContext>,
    id: String,
    delete_files: Option<bool>,
) -> Result<(), String> {
    let handle = {
        let list = ctx.downloads.lock().unwrap();
        list.iter().find(|t| t.id == id).map(|t| t.handle.clone())
    };
    let Some(handle) = handle else {
        return Err("任务不存在".into());
    };
    let session = ctx.torrent_session().await.map_err(|e| e.to_string())?;
    session
        .inner()
        .pause(&handle)
        .await
        .map_err(|e| format!("暂停任务失败：{e}"))?;
    if delete_files == Some(true) {
        session
            .inner()
            .delete(handle.info_hash().into(), true)
            .await
            .map_err(|e| format!("删除文件失败：{e}"))?;
    }
    ctx.downloads.lock().unwrap().retain(|t| t.id != id);
    Ok(())
}

/// 任务里最大的视频文件的本地路径（完成后播放用）。
#[tauri::command]
pub async fn download_video_path(
    ctx: State<'_, AppContext>,
    id: String,
) -> Result<Option<String>, String> {
    let session = ctx.torrent_session().await.map_err(|e| e.to_string())?;
    let handle = {
        let list = ctx.downloads.lock().unwrap();
        list.iter().find(|t| t.id == id).map(|t| t.handle.clone())
    };
    let Some(handle) = handle else {
        return Ok(None);
    };
    session
        .wait_metadata(&handle, std::time::Duration::from_secs(60))
        .await
        .ok();
    let files = ani_torrent::TorrentSession::list_files(&handle).unwrap_or_default();
    let best = files
        .iter()
        .filter(|f| is_video(&f.name))
        .max_by_key(|f| f.length)
        .cloned();
    let dir = session.options().download_dir.clone();
    Ok(best.map(|f| dir.join(&f.name).to_string_lossy().into_owned()))
}

// ---------- 设置 ----------

#[tauri::command]
pub fn get_settings(ctx: State<'_, AppContext>) -> GetSettingsResp {
    let mut paths = std::collections::HashMap::new();
    paths.insert(
        "settings".into(),
        crate::settings::settings_path()
            .to_string_lossy()
            .into_owned(),
    );
    paths.insert(
        "db".into(),
        ani_db::default_db_path().to_string_lossy().into_owned(),
    );
    paths.insert(
        "downloads".into(),
        ctx.effective_download_dir().to_string_lossy().into_owned(),
    );
    GetSettingsResp {
        settings: ctx.settings.read().unwrap().clone(),
        sources: ctx.registry.list_info(),
        paths,
    }
}

#[tauri::command]
pub async fn save_settings(
    ctx: State<'_, AppContext>,
    settings: SettingsData,
) -> Result<(), String> {
    let mut settings = settings;
    // Jellyfin 配置被清空时同步停用其源开关，避免下次启动被默认启用
    if !settings.jellyfin.is_configured() {
        settings.set_source_enabled("jellyfin", false);
    }
    // 1) 先落盘（阻塞 IO 放到 blocking 线程）：失败则内存与 registry 均不变，避免半提交
    let to_save = settings.clone();
    tauri::async_runtime::spawn_blocking(move || to_save.save())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    // 2) 再更新内存
    *ctx.settings.write().unwrap() = settings.clone();
    // 3) 最后同步 registry：Jellyfin 配置有变则重建，源启停即时生效
    let cfg = settings.jellyfin.to_config();
    let applied = ctx.jellyfin_applied.lock().unwrap().clone();
    let has_jellyfin = ctx.registry.list_info().iter().any(|i| i.id == "jellyfin");
    if settings.jellyfin.is_configured() {
        if !has_jellyfin || applied.as_ref() != Some(&cfg) {
            let src = ds_jellyfin::JellyfinSource::connect(&cfg)
                .await
                .map_err(|e| format!("Jellyfin 连接失败：{e}"))?;
            ctx.registry.replace(std::sync::Arc::new(src));
            *ctx.jellyfin_applied.lock().unwrap() = Some(cfg);
        }
    } else if has_jellyfin {
        ctx.registry.set_enabled("jellyfin", false);
        *ctx.jellyfin_applied.lock().unwrap() = None;
    }
    for info in ctx.registry.list_info() {
        ctx.registry
            .set_enabled(&info.id, settings.source_enabled(&info.id));
    }
    Ok(())
}

// ---------- 自绘标题栏的窗口控制 ----------
// 不走 __TAURI__.window 全局包（其注入时机不稳定），用应用自己的 invoke 通道。

/// 真正退出应用（托盘菜单「退出」经前端确认后调用）。
#[tauri::command]
pub fn app_quit(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn win_minimize(win: tauri::WebviewWindow) -> Result<(), String> {
    win.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn win_toggle_maximize(win: tauri::WebviewWindow) -> Result<(), String> {
    if win.is_maximized().unwrap_or(false) {
        win.unmaximize().map_err(|e| e.to_string())
    } else {
        win.maximize().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn win_close(win: tauri::WebviewWindow) -> Result<(), String> {
    win.close().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn win_is_maximized(win: tauri::WebviewWindow) -> bool {
    win.is_maximized().unwrap_or(false)
}

/// 在资源管理器中打开：目录直接打开；文件定位到所在目录并选中（Windows：explorer）。
#[tauri::command]
pub async fn reveal_path(path: String) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW：GUI 进程不闪控制台窗口
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let p = std::path::Path::new(&path);
    let mut cmd = std::process::Command::new("explorer");
    if p.is_dir() {
        cmd.arg(&path);
    } else {
        cmd.arg(format!("/select,{path}"));
    }
    cmd.creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn tier_of(source_id: &str) -> ani_core::MediaSourceTier {
    match source_id {
        "dmhy" | "mikan" => ani_core::MediaSourceTier::Medium,
        "bangumi" => ani_core::MediaSourceTier::High,
        _ => ani_core::MediaSourceTier::Low,
    }
}

fn parse_tier(t: &str) -> ani_core::MediaSourceTier {
    match t {
        "high" => ani_core::MediaSourceTier::High,
        "low" => ani_core::MediaSourceTier::Low,
        _ => ani_core::MediaSourceTier::Medium,
    }
}

// ---------- 在线播放 ----------

/// BT 渐进播放（边下边播的 M2-lite 实现）：
/// 加入种子 → 等元数据 → 选最大的视频文件 → 轮询该文件头部字节
/// （默认 8MB，够 mpv/系统播放器起播）→ 发 `stream-ready` 事件（带本地路径）。
#[tauri::command]
pub async fn start_torrent_stream(
    app: AppHandle,
    ctx: State<'_, AppContext>,
    uri: String,
    title: String,
    ep: Option<f32>,
) -> Result<(), String> {
    let (head_bytes, timeout_secs) = {
        let st = ctx.settings.read().unwrap();
        (
            st.torrent.stream_head_mb.max(1) as u64 * 1024 * 1024,
            st.torrent.stream_timeout_min.max(1) as u64 * 60,
        )
    };
    let session = ctx.torrent_session().await.map_err(|e| e.to_string())?;
    // 磁力的 add 会阻塞到元数据解析完成，死种时可无限挂起，必须包超时
    let handle = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        session.add(&uri),
    )
    .await
    .map_err(|_| "获取种子元数据超时（网络或做种人数不足）".to_string())?
    .map_err(|e| e.to_string())?;
    let download_dir = session.options().download_dir.clone();
    register_download(&app, &ctx, handle.clone(), title.clone());

    tauri::async_runtime::spawn(async move {
        let head_bytes: u64 = head_bytes;
        // 「元数据 + 头部」共享一个总超时预算
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
        if let Err(e) = session
            .wait_metadata(&handle, deadline - tokio::time::Instant::now())
            .await
        {
            let _ = app.emit("stream-failed", &format!("获取种子元数据超时：{e}"));
            return;
        }
        let files = match ani_torrent::TorrentSession::list_files(&handle) {
            Ok(f) => f,
            Err(e) => {
                let _ = app.emit("stream-failed", &format!("列出文件失败：{e}"));
                return;
            }
        };
        // 按集选文件：优先解析出集号与请求一致的候选（复用选源引擎的标题解析），
        // 找不到（合集/电影）时退回最大的视频文件
        let candidates: Vec<_> = files.iter().filter(|f| is_video(&f.name)).collect();
        let video = match ep {
            Some(ep) => candidates
                .iter()
                .filter(|f| {
                    matches!(
                        ani_domain::episode_in_title(&f.name),
                        Some(ani_domain::TitleEpisode::Single(n)) if (n - ep).abs() < 0.01
                    )
                })
                .max_by_key(|f| f.length)
                .or_else(|| candidates.iter().max_by_key(|f| f.length))
                .cloned()
                .cloned(),
            None => candidates.iter().max_by_key(|f| f.length).cloned().cloned(),
        };
        let Some(video) = video else {
            let _ = app.emit("stream-failed", "种子里没有视频文件");
            return;
        };
        let _ = app.emit("stream-file", &video.name);

        // 等头部数据就绪（默认 8MB 或整集下载完），与元数据阶段共享总 deadline
        let head_needed = head_bytes.min(video.length).max(1);
        loop {
            if tokio::time::Instant::now() > deadline {
                let _ = app.emit("stream-failed", "等待头部数据超时（网络或做种人数不足）");
                return;
            }
            let stats = handle.stats();
            let done = stats.file_progress.get(video.index).copied().unwrap_or(0);
            let _ = app.emit(
                "stream-wait",
                &serde_json::json!({
                    "percent": (done as f64 / head_needed as f64 * 100.0).min(100.0),
                    "file": video.name,
                }),
            );
            if done >= head_needed {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        }
        let path = download_dir.join(&video.name);
        let _ = app.emit(
            "stream-ready",
            &serde_json::json!({ "path": path.to_string_lossy(), "title": title, "file": video.name }),
        );
    });
    Ok(())
}

fn is_video(name: &str) -> bool {
    let n = name.to_lowercase();
    [
        ".mp4", ".mkv", ".avi", ".ts", ".flv", ".wmv", ".webm", ".mov", ".m2ts",
    ]
    .iter()
    .any(|ext| n.ends_with(ext))
}

/// 用外部播放器打开本地文件：优先 mpv（设置里可配路径，自动探测 PATH/常见位置），
/// 找不到时用系统默认播放器。async：Tauri 的同步 command 跑在主线程，会卡 UI。
#[tauri::command]
pub async fn spawn_player(ctx: State<'_, AppContext>, path: String) -> Result<String, String> {
    let configured = ctx
        .settings
        .read()
        .unwrap()
        .torrent
        .mpv_path
        .trim()
        .to_string();
    // 子进程探测较慢（全 PATH 扫描），放 blocking 线程避免占死 worker
    let mpv = tauri::async_runtime::spawn_blocking(move || resolve_mpv(&configured))
        .await
        .map_err(|e| e.to_string())?;
    match mpv {
        Some(mpv) => {
            spawn_hidden(std::process::Command::new(&mpv).arg(&path))
                .map_err(|e| format!("启动 mpv 失败：{e}"))?;
            Ok(format!("mpv：{mpv}"))
        }
        None => {
            let mut cmd = std::process::Command::new("cmd");
            cmd.args(["/C", "start", "", &path]);
            spawn_hidden(&mut cmd).map_err(|e| format!("启动系统播放器失败：{e}"))?;
            Ok("系统默认播放器".into())
        }
    }
}

/// GUI 进程 spawn 子进程时隐藏控制台窗口（cmd/where 等会闪黑框）。
fn spawn_hidden(cmd: &mut std::process::Command) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW).spawn().map(|_| ())
}

fn resolve_mpv(configured: &str) -> Option<String> {
    use std::path::PathBuf;
    if !configured.is_empty() && PathBuf::from(configured).exists() {
        return Some(configured.to_string());
    }
    if let Ok(out) = std::process::Command::new("where").arg("mpv").output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout);
            if let Some(first) = s.lines().next() {
                let t = first.trim();
                if !t.is_empty() {
                    return Some(t.to_string());
                }
            }
        }
    }
    let candidates = [
        dirs::data_local_dir().map(|d| d.join("Programs").join("mpv").join("mpv.exe")),
        dirs::home_dir().map(|d| {
            d.join("scoop")
                .join("apps")
                .join("mpv")
                .join("current")
                .join("mpv.exe")
        }),
        Some(PathBuf::from(r"C:\Program Files\mpv\mpv.exe")),
        Some(PathBuf::from(r"C:\Program Files (x86)\mpv\mpv.exe")),
    ];
    candidates
        .into_iter()
        .flatten()
        .find(|p| p.exists())
        .map(|p| p.to_string_lossy().into_owned())
}

// ---------- 播放进度（断点续播） ----------

/// 媒体 key：前端对 url/磁力做 32 位哈希，映射到 playback_history 的 episode_id 槽位。
#[tauri::command]
pub async fn save_progress(
    ctx: State<'_, AppContext>,
    key: i64,
    position_seconds: f64,
    duration_seconds: Option<f64>,
    finished: bool,
) -> Result<(), String> {
    let repo = ani_db::PlaybackRepo::new(ctx.db.clone());
    repo.save_position(&ani_core::PlaybackPosition {
        episode_id: ani_core::EpisodeId(key as u64),
        position_seconds,
        duration_seconds,
        finished,
        updated_at: chrono::Utc::now().timestamp_millis(),
    })
    .await
    .map_err(|e| e.to_string())
}

/// 返回未看完的断点位置（看完的从头播）。
#[tauri::command]
pub async fn load_progress(ctx: State<'_, AppContext>, key: i64) -> Result<Option<f64>, String> {
    let repo = ani_db::PlaybackRepo::new(ctx.db.clone());
    let pos = repo
        .load_position(ani_core::EpisodeId(key as u64))
        .await
        .map_err(|e| e.to_string())?;
    Ok(pos
        .filter(|p| !p.finished && p.position_seconds > 30.0)
        .map(|p| p.position_seconds))
}

// ---------- 设置辅助：源测试 / Jellyfin 测试 / mpv 检测 ----------

#[derive(serde::Serialize)]
pub struct SourceTestResult {
    pub ok: bool,
    pub count: usize,
    pub ms: u128,
    pub error: Option<String>,
}

/// 数据源连通性测试：用固定关键词真实请求一次。
#[tauri::command]
pub async fn test_source(
    ctx: State<'_, AppContext>,
    id: String,
) -> Result<SourceTestResult, String> {
    let src = ctx
        .registry
        .sources()
        .into_iter()
        .find(|s| s.info().id == id)
        .ok_or("源不存在")?;
    let req = MediaFetchRequest {
        subject_name: "葬送的芙莉莲".into(),
        aliases: vec!["Sousou no Frieren".into()],
        ..Default::default()
    };
    let t0 = std::time::Instant::now();
    match src.fetch(&req).await {
        Ok(ms) => Ok(SourceTestResult {
            ok: true,
            count: ms.len(),
            ms: t0.elapsed().as_millis(),
            error: None,
        }),
        Err(e) => Ok(SourceTestResult {
            ok: false,
            count: 0,
            ms: t0.elapsed().as_millis(),
            error: Some(e.to_string()),
        }),
    }
}

/// Jellyfin 连接测试（用设置页当前填写的值，不必先保存）。
#[tauri::command]
pub async fn test_jellyfin(cfg: crate::settings::JellyfinSettings) -> Result<String, String> {
    if !cfg.is_configured() {
        return Err("请先填写服务器地址和用户名（或 API Key）".into());
    }
    let src = ds_jellyfin::JellyfinSource::connect(&cfg.to_config())
        .await
        .map_err(|e| format!("连接失败：{e}"))?;
    // 真发一次搜索证明 API 可用
    let req = MediaFetchRequest {
        subject_name: "a".into(),
        ..Default::default()
    };
    use ani_core::MediaSource as _;
    let n = src
        .fetch(&req)
        .await
        .map_err(|e| format!("API 调用失败：{e}"))?
        .len();
    Ok(format!("连接成功，媒体库可访问（测试检索 {n} 条）"))
}

/// mpv 探测（设置页「检测」按钮）。async：探测要扫 PATH，不能卡主线程。
#[tauri::command]
pub async fn check_mpv(ctx: State<'_, AppContext>) -> Result<Option<String>, String> {
    let configured = ctx
        .settings
        .read()
        .unwrap()
        .torrent
        .mpv_path
        .trim()
        .to_string();
    tauri::async_runtime::spawn_blocking(move || resolve_mpv(&configured))
        .await
        .map_err(|e| e.to_string())
}

// ---------- 弹幕（dandanplay） ----------

/// 弹幕拉取结果（comments 已经过引擎层去重 + 用户屏蔽过滤，按时间升序）。
#[derive(serde::Serialize)]
pub struct DanmakuFetchResult {
    pub matched: bool,
    pub title: String,
    pub comments: Vec<ani_danmaku::DanmakuEvent>,
}

/// 按番名 + 集号从 dandanplay 拉弹幕。未配置 AppId/未匹配到集时 matched=false。
/// 结果缓存 3 天（SQLite），网络失败时回落过期缓存。
#[tauri::command]
pub async fn danmaku_fetch(
    ctx: State<'_, AppContext>,
    subject_name: String,
    ep: Option<f32>,
) -> Result<DanmakuFetchResult, String> {
    let unmatched = || DanmakuFetchResult {
        matched: false,
        title: String::new(),
        comments: Vec::new(),
    };
    let Some(ep) = ep else { return Ok(unmatched()) };
    let (enabled, app_id, app_secret, filter) = {
        let st = ctx.settings.read().unwrap();
        (
            st.danmaku_source.enabled,
            st.danmaku_source.app_id.trim().to_string(),
            st.danmaku_source.app_secret.trim().to_string(),
            st.danmaku.clone(),
        )
    };
    if !enabled || app_id.is_empty() || app_secret.is_empty() || subject_name.trim().is_empty() {
        return Ok(unmatched());
    }
    let subject_name = subject_name.trim().to_string();
    let cache_key = format!("dp:q:{subject_name}|{ep}");
    let repo = ani_db::DanmakuCacheRepo::new(ctx.db.clone());
    let cached = repo.get(&cache_key).await.unwrap_or(None);
    // 3 天内视为新鲜（弹幕池持续增长，过旧该刷新）
    let fresh = cached
        .as_ref()
        .filter(|(_, _, at)| chrono::Utc::now().timestamp_millis() - *at < 3 * 24 * 3600 * 1000);
    if let Some((title, json, _)) = fresh {
        if let Ok(comments) = serde_json::from_str::<Vec<ani_danmaku::DanmakuEvent>>(json) {
            return Ok(DanmakuFetchResult {
                matched: true,
                title: title.clone(),
                comments,
            });
        }
    }

    let client = ani_danmaku::dandanplay::DandanplayClient::new(app_id, app_secret);
    match client.fetch_episode_comments(&subject_name, ep).await {
        Ok(Some((title, comments))) => {
            // 引擎层：多源去重 + 用户屏蔽（关键词/用户/类型），渲染层零过滤逻辑
            let merged = ani_danmaku::merge_dedup(vec![comments]);
            let kept: Vec<_> = merged.into_iter().filter(|d| filter.allows(d)).collect();
            let _ = repo
                .put(
                    &cache_key,
                    &title,
                    &serde_json::to_string(&kept).unwrap_or_default(),
                )
                .await;
            Ok(DanmakuFetchResult {
                matched: true,
                title,
                comments: kept,
            })
        }
        Ok(None) => Ok(unmatched()),
        Err(e) => {
            // 拉取失败回落过期缓存（离线/限流时也能看弹幕）
            if let Some((title, json, _)) = cached {
                if let Ok(comments) = serde_json::from_str::<Vec<ani_danmaku::DanmakuEvent>>(&json)
                {
                    tracing::warn!("danmaku fetch failed, falling back to stale cache: {e}");
                    return Ok(DanmakuFetchResult {
                        matched: true,
                        title,
                        comments,
                    });
                }
            }
            Err(e.to_string())
        }
    }
}

// ---------- Bangumi 账号（OAuth + 看完自动打卡） ----------

#[derive(serde::Serialize)]
pub struct BangumiStatus {
    pub has_credentials: bool,
    pub logged_in: bool,
    pub nickname: String,
}

fn bangumi_settings(ctx: &AppContext) -> crate::settings::BangumiAuthSettings {
    ctx.settings.read().unwrap().bangumi.clone()
}

/// 返回可用的 access token：临近过期自动刷新并持久化。
async fn valid_bangumi_token(ctx: &AppContext) -> Result<String, String> {
    let bgm = bangumi_settings(ctx);
    if !bgm.has_credentials() || !bgm.is_logged_in() {
        return Err("未登录 Bangumi".into());
    }
    if chrono::Utc::now().timestamp_millis() <= bgm.expires_at_ms - 120_000 {
        return Ok(bgm.access_token);
    }
    let oauth = ds_bangumi::oauth::BangumiOAuth::new().map_err(|e| e.to_string())?;
    let ts = oauth
        .refresh(&bgm.client_id, &bgm.client_secret, &bgm.refresh_token)
        .await
        .map_err(|e| format!("刷新 Bangumi token 失败：{e}"))?;
    let expires_at = ts.expires_at_ms();
    let mut settings = ctx.settings.read().unwrap().clone();
    settings.bangumi.access_token = ts.access_token;
    settings.bangumi.refresh_token = ts.refresh_token;
    settings.bangumi.expires_at_ms = expires_at;
    let token = settings.bangumi.access_token.clone();
    let to_save = settings.clone();
    tauri::async_runtime::spawn_blocking(move || to_save.save())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    *ctx.settings.write().unwrap() = settings;
    Ok(token)
}

/// 当前登录状态（设置页展示）。
#[tauri::command]
pub fn bangumi_status(ctx: State<'_, AppContext>) -> BangumiStatus {
    let b = bangumi_settings(&ctx);
    BangumiStatus {
        has_credentials: b.has_credentials(),
        logged_in: b.is_logged_in(),
        nickname: b.nickname,
    }
}

/// 生成授权页 URL（前端用 open_url 打开浏览器）。
#[tauri::command]
pub fn bangumi_auth_url(ctx: State<'_, AppContext>) -> Result<String, String> {
    let b = bangumi_settings(&ctx);
    if !b.has_credentials() {
        return Err("请先填写 ClientID 和 ClientSecret".into());
    }
    Ok(ds_bangumi::oauth::BangumiOAuth::auth_url(
        b.client_id.trim(),
        b.redirect_uri.trim(),
    ))
}

/// 用授权码换 token 并登录（拉取昵称后持久化）。
#[tauri::command]
pub async fn bangumi_auth_exchange(
    ctx: State<'_, AppContext>,
    code: String,
) -> Result<String, String> {
    if code.trim().is_empty() {
        return Err("请粘贴授权码".into());
    }
    let b = bangumi_settings(&ctx);
    if !b.has_credentials() {
        return Err("请先填写 ClientID 和 ClientSecret".into());
    }
    let oauth = ds_bangumi::oauth::BangumiOAuth::new().map_err(|e| e.to_string())?;
    let ts = oauth
        .exchange_code(
            b.client_id.trim(),
            b.client_secret.trim(),
            &code,
            b.redirect_uri.trim(),
        )
        .await
        .map_err(|e| e.to_string())?;
    let user = oauth
        .me(&ts.access_token)
        .await
        .map_err(|e| e.to_string())?;
    let expires_at = ts.expires_at_ms();
    let mut settings = ctx.settings.read().unwrap().clone();
    settings.bangumi.access_token = ts.access_token;
    settings.bangumi.refresh_token = ts.refresh_token;
    settings.bangumi.expires_at_ms = expires_at;
    settings.bangumi.nickname = user.nickname.clone();
    let to_save = settings.clone();
    tauri::async_runtime::spawn_blocking(move || to_save.save())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    *ctx.settings.write().unwrap() = settings;
    Ok(user.nickname)
}

#[tauri::command]
pub async fn bangumi_logout(ctx: State<'_, AppContext>) -> Result<(), String> {
    let mut settings = ctx.settings.read().unwrap().clone();
    settings.bangumi.access_token.clear();
    settings.bangumi.refresh_token.clear();
    settings.bangumi.expires_at_ms = 0;
    settings.bangumi.nickname.clear();
    let to_save = settings.clone();
    tauri::async_runtime::spawn_blocking(move || to_save.save())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    *ctx.settings.write().unwrap() = settings;
    Ok(())
}

/// 看完一集后同步到 Bangumi：标记「看过」；条目未收藏时自动建立「在看」。
#[tauri::command]
pub async fn bangumi_mark_watched(
    ctx: State<'_, AppContext>,
    subject_id: u32,
    episode_id: u64,
) -> Result<(), String> {
    let token = valid_bangumi_token(&ctx).await?;
    let oauth = ds_bangumi::oauth::BangumiOAuth::new().map_err(|e| e.to_string())?;
    oauth
        .mark_episode_watched(&token, subject_id, episode_id)
        .await
        .map_err(|e| e.to_string())
}

/// 用系统默认浏览器打开 URL（授权页等）。
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://"))
        || url.contains(['"', '\'', ' ', '\n'])
    {
        return Err("非法 URL".into());
    }
    let mut cmd = std::process::Command::new("cmd");
    cmd.args(["/C", "start", "", &url]);
    spawn_hidden(&mut cmd).map_err(|e| e.to_string())
}

// ---------- 离线缓存（M5 HTTP/HLS 引擎） ----------

pub const USER_AGENT_APP: &str = "ani-rs/0.1 (https://github.com/ani-rs/ani-rs)";

#[derive(serde::Serialize, Clone)]
pub struct CacheProgress {
    pub id: String,
    pub downloaded: u64,
    pub total: u64,
}

#[derive(serde::Serialize, Clone)]
pub struct CacheItemOut {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub url: String,
    pub entry: String,
    pub size_bytes: i64,
    pub created_at: i64,
}

impl From<ani_db::CacheItemRow> for CacheItemOut {
    fn from(r: ani_db::CacheItemRow) -> Self {
        Self {
            id: r.id,
            title: r.title,
            kind: r.kind,
            url: r.url,
            entry: r.entry,
            size_bytes: r.size_bytes,
            created_at: r.created_at,
        }
    }
}

fn http_cache_client() -> anyhow::Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent(USER_AGENT_APP)
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(120))
        .build()?)
}

/// 开始离线缓存（已存在则直接返回缓存项）。下载进度经 `cache-progress` 事件广播。
#[tauri::command]
pub async fn cache_start(
    app: AppHandle,
    ctx: State<'_, AppContext>,
    url: String,
    title: String,
) -> Result<CacheItemOut, String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("仅支持 http(s) 直链或 m3u8".into());
    }
    let id = crate::cache::cache_id(&url);
    let repo = ani_db::CacheItemRepo::new(ctx.db.clone());
    if let Some(existing) = repo.get(&id).await.map_err(|e| e.to_string())? {
        return Ok(existing.into());
    }
    repo.put(&id, title.trim(), &url)
        .await
        .map_err(|e| e.to_string())?;

    let app2 = app.clone();
    let dir = crate::cache::cache_root().join(&id);
    let http = http_cache_client().map_err(|e| e.to_string())?;
    let url2 = url.clone();
    let title2 = title.clone();
    let id2 = id.clone();
    tauri::async_runtime::spawn(async move {
        use tauri::Manager;
        let progress = |done: u64, total: u64| {
            let _ = app2.emit(
                "cache-progress",
                &CacheProgress {
                    id: id2.clone(),
                    downloaded: done,
                    total,
                },
            );
        };
        let outcome = crate::cache::download(&http, &url2, &dir, &progress).await;
        // 下载结束后从 app state 取连接池（spawn 闭包里拿不到 State 借用）
        let db_pool = app2.state::<AppContext>().db.clone();
        let repo = ani_db::CacheItemRepo::new(db_pool);
        match outcome {
            Ok(o) => {
                let _ = repo
                    .update_finish(&id2, o.kind, &o.entry, o.size as i64)
                    .await;
                let _ = crate::cache::write_meta(&dir, &title2, &url2).await;
                let _ = app2.emit(
                    "cache-progress",
                    &CacheProgress {
                        id: id2.clone(),
                        downloaded: o.size,
                        total: o.size,
                    },
                );
                let _ = app2.emit("cache-done", &id2);
            }
            Err(e) => {
                // 失败清理：目录与清单记录都移除，用户可直接重试
                let _ = repo.remove(&id2).await;
                let _ = tokio::fs::remove_dir_all(&dir).await;
                let _ = app2.emit("cache-failed", &format!("{id2}|{e}"));
            }
        }
    });

    let item = repo
        .get(&id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("缓存项创建失败")?;
    Ok(item.into())
}

/// 缓存清单（新→旧）。
#[tauri::command]
pub async fn cache_list(ctx: State<'_, AppContext>) -> Result<Vec<CacheItemOut>, String> {
    let repo = ani_db::CacheItemRepo::new(ctx.db.clone());
    Ok(repo
        .list()
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(Into::into)
        .collect())
}

/// 缓存项的本地目录路径（资源管理器打开用）。
#[tauri::command]
pub fn cache_dir_path(id: String) -> Result<String, String> {
    if id.len() != 16 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("非法缓存 id".into());
    }
    Ok(crate::cache::cache_root()
        .join(&id)
        .to_string_lossy()
        .into_owned())
}

/// 删除缓存项（目录 + 清单记录）。
#[tauri::command]
pub async fn cache_delete(ctx: State<'_, AppContext>, id: String) -> Result<(), String> {
    // 缓存 id 是 16 位十六进制（FNV-1a），防路径穿越
    if id.len() != 16 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("非法缓存 id".into());
    }
    let dir = crate::cache::cache_root().join(&id);
    if dir.is_dir() {
        tokio::fs::remove_dir_all(&dir)
            .await
            .map_err(|e| e.to_string())?;
    }
    let repo = ani_db::CacheItemRepo::new(ctx.db.clone());
    repo.remove(&id).await.map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- 偏好学习（对应 MediaSelectorEventSavePreferenceUseCase） ----------

/// 用户手选某个候选（下载/播放）时调用：把它的字幕组/分辨率记为偏好，参与后续自动选源。
#[tauri::command]
pub async fn learn_media_preference(
    ctx: State<'_, AppContext>,
    group: Option<String>,
    resolution: Option<ani_core::Resolution>,
) -> Result<(), String> {
    let picked = ani_core::Media {
        media_source_id: "".into(),
        title: String::new(),
        kind: ani_core::MediaKind::FullEpisode,
        episode_id: None,
        properties: ani_core::MediaProperties {
            subtitle_group: group.filter(|g| !g.trim().is_empty()),
            resolution,
            ..Default::default()
        },
        download: ani_core::DownloadKind::LocalFile {
            path: String::new(),
        },
    };
    let mut settings = ctx.settings.read().unwrap().clone();
    settings.selector = ani_domain::learn_preference(settings.selector, &picked);
    // 与 save_settings 相同的顺序纪律：先落盘成功，再更新内存
    let to_save = settings.clone();
    tauri::async_runtime::spawn_blocking(move || to_save.save())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    *ctx.settings.write().unwrap() = settings;
    Ok(())
}
