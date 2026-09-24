//! Syncplay（一起看）协同观影系统与本地视频扫描服务。
//!
//! 1. 轻量化 Rust 广播服务器：基于 tokio TcpListener + HTTP SSE 与 REST API，
//!    零新增庞大外部依赖，支持本机与局域网（WiFi、以太网、Tailscale/ZeroTier）多端实时同步。
//! 2. 状态机：支持房主与成员模式、播放/暂停/Seek 毫秒级同步、防漂移智能追赶、
//!    房间实时聊天与弹幕转化、名场面表情反应全屏共鸣。
//! 3. 本地媒体扫描器：扫描文件夹下的视频文件，智能提取动画名称与话次。

use std::collections::HashMap;
use std::net::{SocketAddr, UdpSocket};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, Mutex, RwLock};

/// 房间成员状态
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomMember {
    pub id: String,
    pub nickname: String,
    pub is_host: bool,
    pub joined_at: i64,
    pub last_seen: i64,
    pub current_time: f64,
    pub is_synced: bool,
}

/// 播放同步状态
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaybackState {
    pub playing: bool,
    pub current_time: f64,
    pub playback_rate: f64,
    pub updated_at: i64,
}

impl Default for PlaybackState {
    fn default() -> Self {
        Self {
            playing: false,
            current_time: 0.0,
            playback_rate: 1.0,
            updated_at: current_timestamp(),
        }
    }
}

/// 正在播放的媒体条目元信息
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MediaState {
    pub subject_id: Option<u64>,
    pub subject_title: String,
    pub episode_id: Option<u64>,
    pub episode_sort: Option<f32>,
    pub episode_title: String,
    pub media_url: Option<String>,
}

/// 房间信息摘要
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomInfo {
    pub room_id: String,
    pub room_name: String,
    pub host_nickname: String,
    pub port: u16,
    pub local_ips: Vec<String>,
    pub member_count: usize,
    pub is_active: bool,
    pub playback: PlaybackState,
    pub media: MediaState,
}

/// 广播事件
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub sender_id: Option<String>,
    pub sender_name: Option<String>,
    pub payload: serde_json::Value,
    pub timestamp: i64,
}

fn current_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// 获取本机可能用于局域网通讯的可用 IPv4 地址
pub fn get_local_ip_addresses() -> Vec<String> {
    let mut ips = Vec::new();
    for target in &["8.8.8.8:80", "114.114.114.114:80", "1.1.1.1:80"] {
        if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
            if socket.connect(target).is_ok() {
                if let Ok(addr) = socket.local_addr() {
                    let ip = addr.ip().to_string();
                    if ip != "0.0.0.0" && !ips.contains(&ip) {
                        ips.push(ip);
                    }
                }
            }
        }
    }
    if !ips.contains(&"127.0.0.1".to_string()) {
        ips.push("127.0.0.1".to_string());
    }
    ips
}

/// 房间管理中心
pub struct SyncplayManager {
    is_running: AtomicBool,
    port: std::sync::atomic::AtomicU16,
    room_id: RwLock<String>,
    room_name: RwLock<String>,
    host_nickname: RwLock<String>,
    members: RwLock<HashMap<String, RoomMember>>,
    playback: RwLock<PlaybackState>,
    media: RwLock<MediaState>,
    broadcaster: broadcast::Sender<String>,
    stop_signal: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

impl SyncplayManager {
    pub fn new() -> Self {
        let (tx, _rx) = broadcast::channel(256);
        Self {
            is_running: AtomicBool::new(false),
            port: std::sync::atomic::AtomicU16::new(19280),
            room_id: RwLock::new(String::new()),
            room_name: RwLock::new("一起看房间".to_string()),
            host_nickname: RwLock::new("房主".to_string()),
            members: RwLock::new(HashMap::new()),
            playback: RwLock::new(PlaybackState::default()),
            media: RwLock::new(MediaState::default()),
            broadcaster: tx,
            stop_signal: Mutex::new(None),
        }
    }

    pub fn is_active(&self) -> bool {
        self.is_running.load(Ordering::SeqCst)
    }

    pub async fn get_room_info(&self) -> RoomInfo {
        let port = self.port.load(Ordering::SeqCst);
        let room_id = self.room_id.read().await.clone();
        let room_name = self.room_name.read().await.clone();
        let host_nickname = self.host_nickname.read().await.clone();
        let member_count = self.members.read().await.len();
        let is_active = self.is_active();
        let playback = self.playback.read().await.clone();
        let media = self.media.read().await.clone();
        let local_ips = get_local_ip_addresses();

        RoomInfo {
            room_id,
            room_name,
            host_nickname,
            port,
            local_ips,
            member_count,
            is_active,
            playback,
            media,
        }
    }

    pub async fn stop(&self) {
        if !self.is_running.swap(false, Ordering::SeqCst) {
            return;
        }
        if let Some(stop_tx) = self.stop_signal.lock().await.take() {
            let _ = stop_tx.send(());
        }
        self.members.write().await.clear();
        tracing::info!("Syncplay server stopped");
    }

    pub async fn start(
        self: &Arc<Self>,
        port: u16,
        room_name: String,
        host_nickname: String,
    ) -> anyhow::Result<RoomInfo> {
        self.stop().await;

        let addr = SocketAddr::from(([0, 0, 0, 0], port));
        let listener = TcpListener::bind(addr).await?;
        let actual_port = listener.local_addr()?.port();

        self.port.store(actual_port, Ordering::SeqCst);
        let rid = format!("ROOM-{}", actual_port);
        *self.room_id.write().await = rid.clone();
        *self.room_name.write().await = if room_name.trim().is_empty() {
            "一起看房间".to_string()
        } else {
            room_name
        };
        *self.host_nickname.write().await = if host_nickname.trim().is_empty() {
            "房主".to_string()
        } else {
            host_nickname
        };

        self.is_running.store(true, Ordering::SeqCst);

        let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
        *self.stop_signal.lock().await = Some(stop_tx);

        let mgr = self.clone();
        tokio::spawn(async move {
            tracing::info!(
                "Syncplay server listening on http://0.0.0.0:{}",
                actual_port
            );
            loop {
                tokio::select! {
                    res = listener.accept() => {
                        match res {
                            Ok((stream, peer_addr)) => {
                                let mgr_conn = mgr.clone();
                                tokio::spawn(async move {
                                    if let Err(e) = handle_http_connection(stream, peer_addr, mgr_conn).await {
                                        tracing::debug!("Syncplay connection error: {e}");
                                    }
                                });
                            }
                            Err(e) => {
                                tracing::warn!("Syncplay accept error: {e}");
                                break;
                            }
                        }
                    }
                    _ = &mut stop_rx => {
                        tracing::info!("Syncplay accept loop received stop signal");
                        break;
                    }
                }
            }
        });

        // 定期清理不活跃成员（超时 30 秒）
        let mgr_gc = self.clone();
        tokio::spawn(async move {
            while mgr_gc.is_active() {
                tokio::time::sleep(Duration::from_secs(10)).await;
                let now = current_timestamp();
                let mut members = mgr_gc.members.write().await;
                let before_count = members.len();
                members.retain(|_, m| m.is_host || (now - m.last_seen < 30_000));
                if members.len() != before_count {
                    drop(members);
                    mgr_gc.broadcast_members().await;
                }
            }
        });

        Ok(self.get_room_info().await)
    }

    pub async fn broadcast_members(&self) {
        let members_list: Vec<RoomMember> = self.members.read().await.values().cloned().collect();
        self.emit_event(
            "members_update",
            None,
            None,
            serde_json::to_value(&members_list).unwrap_or_default(),
        );
    }

    pub fn emit_event(
        &self,
        event_type: &str,
        sender_id: Option<String>,
        sender_name: Option<String>,
        payload: serde_json::Value,
    ) {
        let ev = SyncEvent {
            event_type: event_type.to_string(),
            sender_id,
            sender_name,
            payload,
            timestamp: current_timestamp(),
        };
        if let Ok(json_str) = serde_json::to_string(&ev) {
            let _ = self.broadcaster.send(json_str);
        }
    }
}

static SYNCPLAY_MANAGER: std::sync::OnceLock<Arc<SyncplayManager>> = std::sync::OnceLock::new();

pub fn get_syncplay_manager() -> Arc<SyncplayManager> {
    SYNCPLAY_MANAGER
        .get_or_init(|| Arc::new(SyncplayManager::new()))
        .clone()
}

/// 处理 HTTP / SSE 连接
async fn handle_http_connection(
    mut stream: TcpStream,
    _peer_addr: SocketAddr,
    mgr: Arc<SyncplayManager>,
) -> anyhow::Result<()> {
    let mut buf = [0u8; 8192];
    let n = stream.read(&mut buf).await?;
    if n == 0 {
        return Ok(());
    }

    let req_str = String::from_utf8_lossy(&buf[..n]);
    let mut lines = req_str.lines();
    let first_line = lines.next().unwrap_or("");
    let mut parts = first_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");

    // 1. 处理 CORS Preflight
    if method == "OPTIONS" {
        let resp = "HTTP/1.1 204 No Content\r\n\
Access-Control-Allow-Origin: *\r\n\
Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
Access-Control-Allow-Headers: Content-Type, Authorization\r\n\
Access-Control-Max-Age: 86400\r\n\r\n";
        stream.write_all(resp.as_bytes()).await?;
        return Ok(());
    }

    // 2. 处理 SSE 长连接 /events
    if method == "GET" && path.starts_with("/events") {
        let headers = "HTTP/1.1 200 OK\r\n\
Content-Type: text/event-stream\r\n\
Cache-Control: no-cache, no-transform\r\n\
Connection: keep-alive\r\n\
Access-Control-Allow-Origin: *\r\n\r\n";
        stream.write_all(headers.as_bytes()).await?;

        // 首次连接先下发当前房间全量快照
        let info = mgr.get_room_info().await;
        let members: Vec<RoomMember> = mgr.members.read().await.values().cloned().collect();
        let init_data = serde_json::json!({
            "type": "init",
            "room": info,
            "members": members,
            "timestamp": current_timestamp(),
        });
        let msg = format!("data: {}\n\n", serde_json::to_string(&init_data)?);
        stream.write_all(msg.as_bytes()).await?;

        let mut rx = mgr.broadcaster.subscribe();
        let mut ping_interval = tokio::time::interval(Duration::from_secs(12));

        let mut read_buf = [0u8; 128];
        loop {
            tokio::select! {
                res = rx.recv() => {
                    match res {
                        Ok(json_str) => {
                            let frame = format!("data: {}\n\n", json_str);
                            if let Err(e) = stream.write_all(frame.as_bytes()).await {
                                tracing::debug!("SSE write failed (client disconnected): {e}");
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            continue;
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
                _ = ping_interval.tick() => {
                    if let Err(e) = stream.write_all(b": ping\n\n").await {
                        tracing::debug!("SSE ping failed: {e}");
                        break;
                    }
                }
                read_res = stream.read(&mut read_buf) => {
                    match read_res {
                        Ok(0) | Err(_) => {
                            // 客户端主动断开
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }
        return Ok(());
    }

    // 3. 处理 REST API
    let body = if let Some(pos) = req_str.find("\r\n\r\n") {
        &req_str[pos + 4..]
    } else {
        ""
    };

    if method == "GET" && path == "/api/status" {
        let info = mgr.get_room_info().await;
        let members: Vec<RoomMember> = mgr.members.read().await.values().cloned().collect();
        let res = serde_json::json!({
            "room": info,
            "members": members,
        });
        send_json_response(&mut stream, 200, &res).await?;
        return Ok(());
    }

    if method == "POST" {
        let json_body: serde_json::Value =
            serde_json::from_str(body).unwrap_or(serde_json::json!({}));

        match path {
            "/api/join" => {
                let id = json_body["member_id"].as_str().unwrap_or("").to_string();
                let nickname = json_body["nickname"].as_str().unwrap_or("群友").to_string();
                let is_host = json_body["is_host"].as_bool().unwrap_or(false);
                if !id.is_empty() {
                    let now = current_timestamp();
                    let member = RoomMember {
                        id: id.clone(),
                        nickname: nickname.clone(),
                        is_host,
                        joined_at: now,
                        last_seen: now,
                        current_time: 0.0,
                        is_synced: true,
                    };
                    mgr.members.write().await.insert(id.clone(), member.clone());
                    mgr.emit_event(
                        "member_joined",
                        Some(id),
                        Some(nickname),
                        serde_json::to_value(&member)?,
                    );
                    mgr.broadcast_members().await;
                }
                send_json_response(&mut stream, 200, &serde_json::json!({ "ok": true })).await?;
                return Ok(());
            }
            "/api/leave" => {
                let id = json_body["member_id"].as_str().unwrap_or("");
                if let Some(removed) = mgr.members.write().await.remove(id) {
                    mgr.emit_event(
                        "member_left",
                        Some(removed.id),
                        Some(removed.nickname),
                        serde_json::json!({ "id": id }),
                    );
                    mgr.broadcast_members().await;
                }
                send_json_response(&mut stream, 200, &serde_json::json!({ "ok": true })).await?;
                return Ok(());
            }
            "/api/sync" => {
                let sender_id = json_body["sender_id"].as_str().map(|s| s.to_string());
                let sender_name = json_body["sender_name"].as_str().map(|s| s.to_string());
                let playing = json_body["playing"].as_bool().unwrap_or(false);
                let current_time = json_body["position"].as_f64().unwrap_or(0.0);
                let playback_rate = json_body["rate"].as_f64().unwrap_or(1.0);

                let now = current_timestamp();
                {
                    let mut pb = mgr.playback.write().await;
                    pb.playing = playing;
                    pb.current_time = current_time;
                    pb.playback_rate = playback_rate;
                    pb.updated_at = now;
                }

                mgr.emit_event(
                    "playback_sync",
                    sender_id,
                    sender_name,
                    serde_json::json!({
                        "playing": playing,
                        "position": current_time,
                        "rate": playback_rate,
                        "updated_at": now,
                    }),
                );
                send_json_response(&mut stream, 200, &serde_json::json!({ "ok": true })).await?;
                return Ok(());
            }
            "/api/media" => {
                let sender_id = json_body["sender_id"].as_str().map(|s| s.to_string());
                let sender_name = json_body["sender_name"].as_str().map(|s| s.to_string());
                let media_obj: MediaState =
                    serde_json::from_value(json_body["media"].clone()).unwrap_or_default();

                *mgr.media.write().await = media_obj.clone();

                mgr.emit_event(
                    "media_sync",
                    sender_id,
                    sender_name,
                    serde_json::to_value(&media_obj)?,
                );
                send_json_response(&mut stream, 200, &serde_json::json!({ "ok": true })).await?;
                return Ok(());
            }
            "/api/chat" => {
                let sender_id = json_body["sender_id"].as_str().map(|s| s.to_string());
                let sender_name = json_body["sender_name"]
                    .as_str()
                    .unwrap_or("群友")
                    .to_string();
                let text = json_body["text"].as_str().unwrap_or("").trim().to_string();
                if !text.is_empty() {
                    mgr.emit_event(
                        "chat",
                        sender_id,
                        Some(sender_name),
                        serde_json::json!({
                            "text": text,
                            "timestamp": current_timestamp(),
                        }),
                    );
                }
                send_json_response(&mut stream, 200, &serde_json::json!({ "ok": true })).await?;
                return Ok(());
            }
            "/api/reaction" => {
                let sender_id = json_body["sender_id"].as_str().map(|s| s.to_string());
                let sender_name = json_body["sender_name"]
                    .as_str()
                    .unwrap_or("群友")
                    .to_string();
                let emoji = json_body["emoji"].as_str().unwrap_or("🎉").to_string();
                mgr.emit_event(
                    "reaction",
                    sender_id,
                    Some(sender_name),
                    serde_json::json!({
                        "emoji": emoji,
                        "timestamp": current_timestamp(),
                    }),
                );
                send_json_response(&mut stream, 200, &serde_json::json!({ "ok": true })).await?;
                return Ok(());
            }
            "/api/heartbeat" => {
                let id = json_body["member_id"].as_str().unwrap_or("");
                let pos = json_body["position"].as_f64().unwrap_or(0.0);
                let is_synced = json_body["is_synced"].as_bool().unwrap_or(true);
                let now = current_timestamp();
                if let Some(m) = mgr.members.write().await.get_mut(id) {
                    m.last_seen = now;
                    m.current_time = pos;
                    m.is_synced = is_synced;
                }
                send_json_response(&mut stream, 200, &serde_json::json!({ "ok": true })).await?;
                return Ok(());
            }
            _ => {}
        }
    }

    send_json_response(
        &mut stream,
        404,
        &serde_json::json!({ "error": "Not Found" }),
    )
    .await?;
    Ok(())
}

async fn send_json_response(
    stream: &mut TcpStream,
    status: u16,
    data: &serde_json::Value,
) -> anyhow::Result<()> {
    let body = serde_json::to_string(data)?;
    let status_line = match status {
        200 => "HTTP/1.1 200 OK",
        404 => "HTTP/1.1 404 Not Found",
        _ => "HTTP/1.1 500 Internal Server Error",
    };
    let resp = format!(
        "{}\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status_line,
        body.len(),
        body
    );
    stream.write_all(resp.as_bytes()).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 本地视频媒体扫描系统 (Local Media Scanner)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalMediaItem {
    pub path: String,
    pub filename: String,
    pub size_bytes: u64,
    pub modified_secs: u64,
    pub clean_title: String,
    pub episode_num: Option<u32>,
    pub extension: String,
}

/// 智能解析动画文件名，提取动画标题与话次编号
pub fn parse_anime_filename(name: &str) -> (String, Option<u32>) {
    let stem = if let Some(idx) = name.rfind('.') {
        &name[..idx]
    } else {
        name
    };

    let mut ep_num = None;

    // 1. 中文常见模式：第 N 话 / 第 N 集
    if let Some(pos) = stem.find('第') {
        let after = &stem[pos + '第'.len_utf8()..];
        if let Some(end_pos) = after.find(['话', '話', '集']) {
            let num_str = after[..end_pos].trim();
            if let Ok(n) = num_str.parse::<u32>() {
                ep_num = Some(n);
            }
        }
    }

    // 2. 常见模式：EP01, E01, Ep.02
    if ep_num.is_none() {
        for prefix in &["EP", "ep", "Ep", "E", "e"] {
            if let Some(pos) = stem.find(prefix) {
                let after = &stem[pos + prefix.len()..];
                let after_trimmed = after.trim_start_matches('.');
                let digits: String = after_trimmed
                    .chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect();
                if !digits.is_empty() {
                    if let Ok(n) = digits.parse::<u32>() {
                        if n > 0 && n < 2000 {
                            ep_num = Some(n);
                            break;
                        }
                    }
                }
            }
        }
    }

    // 3. 常见分隔模式：" - 01 " 或 "[01]" 或 " 01 "
    if ep_num.is_none() {
        for part in stem.split(['-', ' ', '_', '.', '[', ']', '(', ')']) {
            let trimmed = part.trim();
            if !trimmed.is_empty() && trimmed.chars().all(|c| c.is_ascii_digit()) {
                if let Ok(n) = trimmed.parse::<u32>() {
                    // 排除 1080, 720, 2024 等年份与分辨率标记
                    if n > 0 && n <= 350 && trimmed.len() <= 3 {
                        ep_num = Some(n);
                        break;
                    }
                }
            }
        }
    }

    // 4. 清洗标题：剥离最前面的字幕组标签与末尾的分辨率/编码标签
    let mut cleaned = String::new();
    let mut in_bracket = false;
    let mut in_paren = false;

    for c in stem.chars() {
        match c {
            '[' | '【' => in_bracket = true,
            ']' | '】' => in_bracket = false,
            '(' | '（' => in_paren = true,
            ')' | '）' => in_paren = false,
            _ => {
                if !in_bracket && !in_paren {
                    cleaned.push(c);
                }
            }
        }
    }

    let clean_title = cleaned
        .trim()
        .trim_matches(|c| c == '-' || c == '_' || c == '.' || c == ' ')
        .trim()
        .to_string();

    // 如果把括号全剥离后只剩空串（例如动画名字本身就是 【推しの子】），回退保留第一个括号内容或原名
    let final_title = if clean_title.trim().is_empty() {
        stem.to_string()
    } else {
        clean_title
    };

    (final_title, ep_num)
}

/// 扫描指定本地目录下的全部可用动画视频文件
pub async fn scan_directory_for_videos(root: &Path) -> Result<Vec<LocalMediaItem>, String> {
    if !root.exists() {
        return Err(format!("目录不存在: {}", root.display()));
    }
    if !root.is_dir() {
        return Err(format!("路径不是目录: {}", root.display()));
    }

    let mut results = Vec::new();
    let mut dirs_to_visit = vec![(root.to_path_buf(), 0usize)];
    const MAX_DEPTH: usize = 3;

    while let Some((curr_dir, depth)) = dirs_to_visit.pop() {
        let mut entries = match tokio::fs::read_dir(&curr_dir).await {
            Ok(e) => e,
            Err(_) => continue,
        };

        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            let file_type = match entry.file_type().await {
                Ok(ft) => ft,
                Err(_) => continue,
            };

            if file_type.is_dir() {
                if depth < MAX_DEPTH {
                    dirs_to_visit.push((path, depth + 1));
                }
            } else if file_type.is_file() {
                let ext = path
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                if matches!(ext.as_str(), "mp4" | "mkv" | "webm" | "avi" | "mov" | "flv") {
                    let filename = path
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string();
                    let metadata = entry.metadata().await.ok();
                    let size_bytes = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
                    let modified_secs = metadata
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0);

                    let (clean_title, episode_num) = parse_anime_filename(&filename);

                    results.push(LocalMediaItem {
                        path: path.to_string_lossy().to_string(),
                        filename,
                        size_bytes,
                        modified_secs,
                        clean_title,
                        episode_num,
                        extension: ext,
                    });
                }
            }
        }
    }

    // 默认按修改时间降序排序（最新下载的排在最前）
    results.sort_by_key(|b| std::cmp::Reverse(b.modified_secs));
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_anime_filename() {
        let (title, ep) = parse_anime_filename("[Lilith-Raws] Frieren - 08 [Baha][1080p].mp4");
        assert_eq!(ep, Some(8));
        assert!(title.contains("Frieren"));

        let (_, ep2) =
            parse_anime_filename("【喵萌奶茶屋】★10月新番 葬送的芙莉莲 第04话 1080p.mkv");
        assert_eq!(ep2, Some(4));

        let (_, ep3) = parse_anime_filename("Dungeon.Meshi.S01E12.1080p.WEBRip.x264.mkv");
        assert_eq!(ep3, Some(12));
    }

    #[test]
    fn test_get_local_ips() {
        let ips = get_local_ip_addresses();
        assert!(!ips.is_empty());
        assert!(ips.contains(&"127.0.0.1".to_string()));
    }
}
