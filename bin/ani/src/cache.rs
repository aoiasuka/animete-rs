//! HTTP/HLS 离线缓存引擎（对应 Ani `domain/media/cache` 的 HTTP 引擎，M5）。
//!
//! 直链或 HLS(m3u8) → 下载到 `%APPDATA%/ani-rs/cache/<id>/`
//! → 经 `anicache://` 自定义协议回放（`http://anicache.localhost/<id>/<entry>`）。
//! 解析/重写为纯函数，fixture 单测兜底。

use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub fn cache_root() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("ani-rs")
        .join("cache")
}

/// 稳定 FNV-1a 64：同一 URL 跨启动得到同一缓存 id（SQLite 主键/目录名）。
pub fn cache_id(url: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in url.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    format!("{h:016x}")
}

pub fn is_hls(text: &str) -> bool {
    text.trim_start().starts_with("#EXTM3U")
}

pub fn is_master_playlist(text: &str) -> bool {
    text.contains("#EXT-X-STREAM-INF")
}

/// 从 master playlist 挑带宽最高的变体。
pub fn pick_best_variant(text: &str, base: &url::Url) -> Option<url::Url> {
    let lines: Vec<&str> = text.lines().map(str::trim).collect();
    let mut best: Option<(u64, url::Url)> = None;
    for (i, line) in lines.iter().enumerate() {
        let Some(rest) = line.strip_prefix("#EXT-X-STREAM-INF:") else {
            continue;
        };
        let bandwidth = rest
            .split(',')
            .find_map(|kv| {
                kv.trim()
                    .strip_prefix("BANDWIDTH=")
                    .and_then(|v| v.parse::<u64>().ok())
            })
            .unwrap_or(0);
        // 变体 URI 是标签后的第一个非注释行
        let Some(uri) = lines[i + 1..]
            .iter()
            .find(|l| !l.is_empty() && !l.starts_with('#'))
        else {
            continue;
        };
        if let Ok(u) = base.join(uri.trim()) {
            if best.as_ref().is_none_or(|(b, _)| bandwidth > *b) {
                best = Some((bandwidth, u));
            }
        }
    }
    best.map(|(_, u)| u)
}

/// 媒体 playlist：提取 init 段与分段 URI（保持顺序）。加密流（AES-128/SAMPLE-AES）拒绝。
pub fn parse_media_playlist(text: &str) -> anyhow::Result<(Option<String>, Vec<String>)> {
    let mut init = None;
    let mut segs = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("#EXT-X-KEY:") {
            let method = rest
                .split(',')
                .find_map(|kv| kv.trim().strip_prefix("METHOD="))
                .unwrap_or("NONE")
                .trim_matches('"');
            if method != "NONE" {
                anyhow::bail!("暂不支持加密 HLS 流（{method}）");
            }
        }
        if let Some(rest) = line.strip_prefix("#EXT-X-MAP:") {
            if let Some(uri) = attr_value(rest, "URI") {
                init = Some(uri);
            }
            continue;
        }
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        segs.push(line.to_string());
    }
    Ok((init, segs))
}

fn attr_value(line: &str, key: &str) -> Option<String> {
    line.split(',').find_map(|kv| {
        let kv = kv.trim();
        let rest = kv.strip_prefix(&format!("{key}="))?;
        Some(rest.trim_matches('"').to_string())
    })
}

/// 重写媒体 playlist：分段/init 指向本地文件名（保留时长等标签）。
/// 与 [`parse_media_playlist`] 的分段判定规则一致，按顺序替换。
pub fn rewrite_media_playlist(
    text: &str,
    init_name: Option<&str>,
    seg_names: &[String],
) -> anyhow::Result<String> {
    if text.contains("#EXT-X-BYTERANGE") {
        anyhow::bail!("暂不支持 BYTERANGE 分段");
    }
    let mut out = String::with_capacity(text.len() + 64);
    let mut seg_i = 0usize;
    for line in text.lines() {
        let line = line.trim_end();
        if line.starts_with("#EXT-X-MAP:") {
            if let Some(name) = init_name {
                out.push_str(&format!("#EXT-X-MAP:URI=\"{name}\"\n"));
            }
            continue;
        }
        if !line.is_empty() && !line.starts_with('#') {
            let name = seg_names
                .get(seg_i)
                .cloned()
                .unwrap_or_else(|| format!("seg_{seg_i:05}.ts"));
            seg_i += 1;
            out.push_str(&name);
            out.push('\n');
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    Ok(out)
}

/// 从 URL 路径里取扩展名（带点），无则给默认值。
pub fn ext_of(url: &url::Url, default: &str) -> String {
    url.path()
        .rsplit('/')
        .next()
        .and_then(|f| f.rsplit_once('.'))
        .map(|(_, ext)| format!(".{}", ext.to_ascii_lowercase()))
        .filter(|e| e.len() <= 6 && e[1..].chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or_else(|| default.to_string())
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadOutcome {
    /// 播放入口文件名（index.m3u8 / video.mp4）
    pub entry: String,
    pub kind: &'static str,
    pub size: u64,
}

/// 下载一个缓存项（阻塞到完成；进度回调 (已完成字节, 已知总字节)）。
pub async fn download(
    http: &reqwest::Client,
    url: &str,
    dir: &Path,
    on_progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> anyhow::Result<DownloadOutcome> {
    tokio::fs::create_dir_all(dir)
        .await
        .with_context(|| format!("创建缓存目录失败：{}", dir.display()))?;
    let base: url::Url = url.parse().context("非法的缓存 URL")?;

    let text = fetch_text(http, &base).await?;
    if !is_hls(&text) {
        return download_direct(http, &base, dir, on_progress).await;
    }

    // HLS：master → 最高码率变体 → 媒体 playlist → 分段
    let (media_url, media_text) = if is_master_playlist(&text) {
        let variant = pick_best_variant(&text, &base).context("master playlist 里没有可用画质")?;
        let t = fetch_text(http, &variant).await?;
        (variant, t)
    } else {
        (base.clone(), text)
    };
    let (init_uri, seg_uris) = parse_media_playlist(&media_text).context("解析 m3u8 失败")?;
    if seg_uris.is_empty() {
        anyhow::bail!("m3u8 里没有分段");
    }

    let mut done: u64 = 0;
    let mut total: u64 = 0;

    let mut init_name = None;
    if let Some(uri) = &init_uri {
        let u = media_url.join(uri)?;
        let name = format!("init{}", ext_of(&u, ".m4s"));
        let bytes = fetch_bytes_with_progress(http, &u, &mut |n, known| {
            on_progress(done + n, total.saturating_add(known))
        })
        .await?;
        total += bytes.len() as u64;
        done += bytes.len() as u64;
        tokio::fs::write(dir.join(&name), bytes).await?;
        init_name = Some(name);
    }

    let mut seg_names = Vec::with_capacity(seg_uris.len());
    for (i, uri) in seg_uris.iter().enumerate() {
        let u = media_url.join(uri)?;
        let name = format!("seg_{i:05}{}", ext_of(&u, ".ts"));
        let bytes = fetch_bytes_with_progress(http, &u, &mut |n, known| {
            on_progress(done + n, total.saturating_add(known))
        })
        .await
        .with_context(|| format!("下载分段 {}/{} 失败", i + 1, seg_uris.len()))?;
        total += bytes.len() as u64;
        done += bytes.len() as u64;
        on_progress(done, total);
        tokio::fs::write(dir.join(&name), bytes).await?;
        seg_names.push(name);
    }

    let rewritten = rewrite_media_playlist(&media_text, init_name.as_deref(), &seg_names)?;
    tokio::fs::write(dir.join("index.m3u8"), rewritten).await?;
    on_progress(done, total);
    Ok(DownloadOutcome {
        entry: "index.m3u8".into(),
        kind: "hls",
        size: done,
    })
}

async fn download_direct(
    http: &reqwest::Client,
    url: &url::Url,
    dir: &Path,
    on_progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> anyhow::Result<DownloadOutcome> {
    let resp = http.get(url.clone()).send().await?.error_for_status()?;
    let total = resp.content_length().unwrap_or(0);
    let name = format!("video{}", ext_of(url, ".mp4"));
    let mut file = tokio::fs::File::create(dir.join(&name)).await?;
    let mut done: u64 = 0;
    let mut resp = resp;
    while let Some(chunk) = resp.chunk().await? {
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk).await?;
        done += chunk.len() as u64;
        on_progress(done, total);
    }
    tokio::io::AsyncWriteExt::flush(&mut file).await?;
    Ok(DownloadOutcome {
        entry: name,
        kind: "file",
        size: done,
    })
}

async fn fetch_text(http: &reqwest::Client, u: &url::Url) -> anyhow::Result<String> {
    http.get(u.clone())
        .send()
        .await
        .context("请求失败")?
        .error_for_status()
        .context("服务端返回错误")?
        .text()
        .await
        .context("读取响应失败")
}

/// 单段下载（失败重试一次）；on_part(本段已完成, 本段已知总长)。
async fn fetch_bytes_with_progress(
    http: &reqwest::Client,
    u: &url::Url,
    on_part: &mut (dyn FnMut(u64, u64) + Send),
) -> anyhow::Result<Vec<u8>> {
    let mut last_err: Option<anyhow::Error> = None;
    for attempt in 0..2 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        match http.get(u.clone()).send().await {
            Ok(resp) => match resp.error_for_status() {
                Ok(mut resp) => {
                    let total = resp.content_length().unwrap_or(0);
                    let mut bytes = Vec::with_capacity(total as usize);
                    loop {
                        match resp.chunk().await {
                            Ok(Some(c)) => {
                                bytes.extend_from_slice(&c);
                                on_part(bytes.len() as u64, total);
                            }
                            Ok(None) => return Ok(bytes),
                            Err(e) => {
                                last_err = Some(e.into());
                                break;
                            }
                        }
                    }
                }
                Err(e) => last_err = Some(e.into()),
            },
            Err(e) => last_err = Some(e.into()),
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("分段下载失败")))
}

/// 自定义协议回放：按相对路径读缓存文件（拒绝目录穿越）。
#[allow(dead_code)]
pub fn serve_file(rel_path: &str) -> tauri::http::Response<Vec<u8>> {
    serve_file_with_range(rel_path, None)
}

pub fn serve_file_with_range(
    rel_path: &str,
    range_hdr: Option<&str>,
) -> tauri::http::Response<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    use tauri::http::{Response, StatusCode};

    let bad = |code: StatusCode| {
        Response::builder()
            .status(code)
            .body(Vec::new())
            .expect("static response")
    };
    let rel = rel_path.trim_matches('/');
    if rel.is_empty() || rel.split(['/', '\\']).any(|p| p == "..") {
        return bad(StatusCode::NOT_FOUND);
    }
    let p = cache_root().join(rel);
    let mut file = match std::fs::File::open(&p) {
        Ok(f) => f,
        Err(_) => return bad(StatusCode::NOT_FOUND),
    };
    let meta = match file.metadata() {
        Ok(m) => m,
        Err(_) => return bad(StatusCode::INTERNAL_SERVER_ERROR),
    };
    if !meta.is_file() {
        return bad(StatusCode::NOT_FOUND);
    }

    let len = meta.len();
    let mime = mime_of(&p);

    if len == 0 {
        return Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", mime)
            .header("Content-Length", "0")
            .header("Accept-Ranges", "bytes")
            .header("Access-Control-Allow-Origin", "*")
            .body(Vec::new())
            .expect("valid response");
    }

    // Range 支持：允许视频拖动进度条，且避免把数 GiB 视频读入内存
    if let Some(range_spec) = range_hdr.and_then(|h| h.trim().strip_prefix("bytes=")) {
        let first = range_spec.split(',').next().unwrap_or("").trim();
        if let Some((start_s, end_s)) = first.split_once('-') {
            let parsed_range: Option<(u64, u64)> = if start_s.trim().is_empty() {
                // 后缀区间 bytes=-N
                end_s
                    .trim()
                    .parse::<u64>()
                    .ok()
                    .filter(|&n| n > 0)
                    .map(|n| {
                        let start = len.saturating_sub(n);
                        (start, len - 1)
                    })
            } else if let Ok(start) = start_s.trim().parse::<u64>() {
                if start < len {
                    let end = end_s.trim().parse::<u64>().unwrap_or(len - 1).min(len - 1);
                    if end >= start {
                        Some((start, end))
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            };

            if let Some((start, end)) = parsed_range {
                // 每次最多回 4MiB，客户端媒体栈会自动按需发起后续 Range 请求
                const CHUNK: u64 = 4 * 1024 * 1024;
                let end = end.min(start + CHUNK - 1);
                let chunk_len = (end - start + 1) as usize;
                if file.seek(SeekFrom::Start(start)).is_ok() {
                    let mut buf = vec![0u8; chunk_len];
                    if file.read_exact(&mut buf).is_ok() {
                        return Response::builder()
                            .status(StatusCode::PARTIAL_CONTENT)
                            .header("Content-Type", mime)
                            .header("Content-Length", chunk_len.to_string())
                            .header("Content-Range", format!("bytes {start}-{end}/{len}"))
                            .header("Accept-Ranges", "bytes")
                            .header("Access-Control-Allow-Origin", "*")
                            .header("Access-Control-Allow-Methods", "GET, OPTIONS")
                            .body(buf)
                            .expect("valid response");
                    }
                }
            } else {
                return Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header("Content-Range", format!("bytes */{len}"))
                    .body(Vec::new())
                    .expect("static response");
            }
        }
    }

    // 全量回传（小文件或无 Range 头）
    let mut bytes = Vec::with_capacity(len.min(8 * 1024 * 1024) as usize);
    if file.read_to_end(&mut bytes).is_ok() {
        Response::builder()
            .header("Content-Type", mime)
            .header("Content-Length", bytes.len().to_string())
            .header("Accept-Ranges", "bytes")
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Allow-Methods", "GET, OPTIONS")
            .body(bytes)
            .expect("valid response")
    } else {
        bad(StatusCode::INTERNAL_SERVER_ERROR)
    }
}

fn mime_of(p: &Path) -> &'static str {
    match p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "m3u8" | "m3u" => "application/vnd.apple.mpegurl",
        "ts" => "video/mp2t",
        "m4s" | "mp4" => "video/mp4",
        "aac" => "audio/aac",
        "vtt" => "text/vtt",
        _ => "application/octet-stream",
    }
}

/// meta.json（缓存目录内的原始信息留存）。
#[derive(Debug, Deserialize, Serialize)]
pub struct CacheMeta {
    pub title: String,
    pub url: String,
}

pub async fn write_meta(dir: &Path, title: &str, url: &str) -> anyhow::Result<()> {
    let meta = CacheMeta {
        title: title.to_string(),
        url: url.to_string(),
    };
    tokio::fs::write(dir.join("meta.json"), serde_json::to_vec(&meta)?).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const MASTER: &str = r#"#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=640x360
360p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4128000,RESOLUTION=1920x1080
1080p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1280x720
720p/index.m3u8
"#;

    const MEDIA: &str = r#"#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXTINF:5.0,
seg-0.ts
#EXTINF:5.0,
sub/seg-1.ts
#EXTINF:4.8,
seg-2.ts
#EXT-X-ENDLIST
"#;

    #[test]
    fn picks_highest_bandwidth_variant() {
        let base = url::Url::parse("https://jf.local/Videos/1/master.m3u8").unwrap();
        let v = pick_best_variant(MASTER, &base).unwrap();
        assert_eq!(v.as_str(), "https://jf.local/Videos/1/1080p/index.m3u8");
    }

    #[test]
    fn parses_media_playlist_and_rejects_encryption() {
        let (init, segs) = parse_media_playlist(MEDIA).unwrap();
        assert!(init.is_none());
        assert_eq!(segs, vec!["seg-0.ts", "sub/seg-1.ts", "seg-2.ts"]);

        let encrypted = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"k\"\n#EXTINF:5,\na.ts\n";
        assert!(parse_media_playlist(encrypted).is_err());
    }

    #[test]
    fn rewrites_to_local_names_in_order() {
        let (init, segs) = parse_media_playlist(MEDIA).unwrap();
        let names: Vec<String> = segs
            .iter()
            .enumerate()
            .map(|(i, _)| format!("seg_{i:05}.ts"))
            .collect();
        let out = rewrite_media_playlist(MEDIA, init.as_deref(), &names).unwrap();
        let (_, segs2) = parse_media_playlist(&out).unwrap();
        assert_eq!(segs2, names);
        assert!(out.contains("#EXTINF:5.0,"), "时长标签保留");
        assert!(!out.contains("sub/"), "原 URI 不残留");
    }

    #[test]
    fn handles_init_map_line() {
        let text = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:4,\na.m4s\n";
        let (init, segs) = parse_media_playlist(text).unwrap();
        assert_eq!(init.as_deref(), Some("init.mp4"));
        assert_eq!(segs, vec!["a.m4s"]);
        let out =
            rewrite_media_playlist(text, Some("init00000.m4s"), &["seg_00000.m4s".into()]).unwrap();
        assert!(out.contains("#EXT-X-MAP:URI=\"init00000.m4s\""));
        assert!(out.contains("seg_00000.m4s"));
        assert!(!out.contains("a.m4s"));
    }

    #[test]
    fn stable_cache_id_and_ext() {
        assert_eq!(cache_id("https://a"), cache_id("https://a"));
        assert_ne!(cache_id("https://a"), cache_id("https://b"));
        let u = url::Url::parse("https://x/y/ep.ts?token=1").unwrap();
        assert_eq!(ext_of(&u, ".ts"), ".ts");
        let u2 = url::Url::parse("https://x/y/noext").unwrap();
        assert_eq!(ext_of(&u2, ".mp4"), ".mp4");
    }

    #[test]
    fn serve_rejects_traversal() {
        let r = serve_file("../settings.json");
        assert_eq!(r.status(), 404);
        let r = serve_file("");
        assert_eq!(r.status(), 404);
    }
}
