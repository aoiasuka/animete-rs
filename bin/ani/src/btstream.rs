//! BT 渐进播放协议（anibt://，对应蓝图 M2：StreamingReader 接入应用内播放器）。
//!
//! 前端把 `<video>` 指到 `http://anibt.localhost/v/<info_hash>/<file_index>`，
//! 这里把 librqbit 的文件流（AsyncRead + AsyncSeek：未下载区间阻塞等 piece、
//! 读位置即下载优先级）翻译成 HTTP Range 语义。弹幕 / 断点续播 / 倍速等
//! 应用内播放器能力由此对 BT 源全部生效，外部 mpv 降级为失败兜底。
//!
//! Tauri 的 UriSchemeResponder 只接受缓冲响应体，不能像 axum 那样整段流式
//! 输出，所以每个请求最多回 [`CHUNK`] 字节（206 + 封顶的 Content-Range），
//! WebView 按消费进度自动续发 Range 请求——对播放器等价于滚动窗口的渐进读取。
//! 无 Range 头的请求按 `bytes=0-` 处理（WebView 媒体栈总会带 Range，
//! 这里兜底避免把整部几 GiB 的文件读进内存）。

use std::time::Duration;

use tauri::http::{Request, Response, StatusCode};
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};

use crate::state::AppContext;

/// 单个响应最多回多少字节：请求体是缓冲的，块太大内存占用高、
/// 且读未下载区间会阻塞到整块就绪；太小则请求次数变多。4MiB 是折中。
const CHUNK: u64 = 4 * 1024 * 1024;
/// 读块超时：目标区间长时间无 piece（死种/慢种）时结束请求而不是无限挂起。
/// 播放器表现为持续缓冲，swarm 恢复后 WebView 续发请求即可继续。
const READ_TIMEOUT: Duration = Duration::from_secs(60);

/// 解析 Range 头的第一个区间，按文件长度收敛成闭区间 (start, end)。
/// `Ok(None)` = 无/不可解析（忽略该头，按全量处理）；`Err(())` = 不可满足（416）。
/// 前置条件：len > 0（len == 0 由调用方先行处理）。
fn parse_range(header: Option<&str>, len: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(spec) = header.and_then(|h| h.trim().strip_prefix("bytes=")) else {
        return Ok(None);
    };
    // 多区间取第一个（媒体栈只发单区间）
    let first = spec.split(',').next().unwrap_or("").trim();
    let Some((start_s, end_s)) = first.split_once('-') else {
        return Ok(None);
    };
    if start_s.trim().is_empty() {
        // 后缀区间 bytes=-N：最后 N 字节
        let Ok(n) = end_s.trim().parse::<u64>() else {
            return Ok(None);
        };
        if n == 0 {
            return Ok(None);
        }
        let start = len.saturating_sub(n);
        return Ok(Some((start, len - 1)));
    }
    let Ok(start) = start_s.trim().parse::<u64>() else {
        return Ok(None);
    };
    if start >= len {
        return Err(());
    }
    // 开区间 bytes=N-（或非数字结尾）读到文件尾；越界收敛到文件尾
    let end = end_s.trim().parse::<u64>().unwrap_or(len - 1).min(len - 1);
    if end < start {
        return Ok(None); // start > end 的非法 spec：忽略整个头
    }
    Ok(Some((start, end)))
}

/// 视频扩展名 → MIME（容器级映射，WebView 媒体栈按此选 demuxer）。
fn video_mime(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "mp4" | "m4v" | "m4s" => "video/mp4",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "ts" | "m2ts" => "video/mp2t",
        "avi" => "video/x-msvideo",
        "mov" => "video/quicktime",
        "flv" => "video/x-flv",
        "wmv" => "video/x-ms-wmv",
        _ => "application/octet-stream",
    }
}

/// 路径 → (info_hash 小写, 文件下标)。仅接受 /v/<40 位十六进制>/<纯数字>，
/// 其余（含目录穿越、空段、多余段）一律拒绝。
fn parse_path(path: &str) -> Option<(String, usize)> {
    let segs: Vec<&str> = path.trim_matches('/').split('/').collect();
    if segs.len() != 3 || segs[0] != "v" {
        return None;
    }
    let hash = segs[1];
    if hash.len() != 40 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some((hash.to_ascii_lowercase(), segs[2].parse().ok()?))
}

fn err_resp(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .body(Vec::new())
        .expect("static response")
}

fn media_resp(
    status: StatusCode,
    mime: &str,
    extra: &[(&str, String)],
    body: Vec<u8>,
) -> Response<Vec<u8>> {
    let mut b = Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Accept-Ranges", "bytes")
        // 与 anicache 一致：页面与协议域不同源，hls.js/fetch 类消费者需要 CORS
        .header("Access-Control-Allow-Origin", "*");
    for (k, v) in extra {
        b = b.header(*k, v);
    }
    b.body(body).expect("valid response")
}

/// anibt:// 协议入口：GET /v/<info_hash>/<file_index> → 206 分块字节流。
/// 种子未登记 / 元数据未就绪 / 文件不存在分别映射 404 / 503 / 404，
/// 读块超时 504、读失败 502——播放器都会走媒体错误路径（前端回落外部播放器）。
pub async fn handle(ctx: &AppContext, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() != "GET" {
        return err_resp(StatusCode::METHOD_NOT_ALLOWED);
    }
    let Some((hash, index)) = parse_path(request.uri().path()) else {
        return err_resp(StatusCode::NOT_FOUND);
    };
    let handle = {
        let list = ctx.downloads.lock().unwrap();
        list.iter().find(|t| t.id == hash).map(|t| t.handle.clone())
    };
    let Some(handle) = handle else {
        return err_resp(StatusCode::NOT_FOUND);
    };
    let files = match ani_torrent::TorrentSession::list_files(&handle) {
        Ok(f) => f,
        Err(_) => return err_resp(StatusCode::SERVICE_UNAVAILABLE), // 元数据未就绪
    };
    let Some(file) = files.get(index) else {
        return err_resp(StatusCode::NOT_FOUND);
    };
    let len = file.length;
    let mime = video_mime(&file.name);
    if len == 0 {
        return media_resp(
            StatusCode::OK,
            mime,
            &[("Content-Length", "0".into())],
            Vec::new(),
        );
    }

    let range_hdr = request.headers().get("range").and_then(|v| v.to_str().ok());
    let (start, end) = match parse_range(range_hdr, len) {
        Ok(Some((s, e))) => (s, e),
        Ok(None) => (0, len - 1),
        Err(()) => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header("Content-Range", format!("bytes */{len}"))
                .body(Vec::new())
                .expect("static response")
        }
    };
    // 封顶分块：响应体是缓冲的，不能把「到文件尾」整段读进内存
    let end = end.min(start + CHUNK - 1);
    let chunk = (end - start + 1) as usize;

    let stream = ani_torrent::TorrentSession::open_stream(&handle, index);
    let mut stream = match stream {
        Ok(s) => s,
        Err(_) => return err_resp(StatusCode::SERVICE_UNAVAILABLE),
    };
    let read = tokio::time::timeout(READ_TIMEOUT, async move {
        stream.seek(SeekFrom::Start(start)).await?;
        let mut buf = vec![0u8; chunk];
        stream.read_exact(&mut buf).await?;
        Ok::<Vec<u8>, std::io::Error>(buf)
    })
    .await;
    let body = match read {
        Ok(Ok(buf)) => buf,
        Ok(Err(_)) => return err_resp(StatusCode::BAD_GATEWAY),
        Err(_) => return err_resp(StatusCode::GATEWAY_TIMEOUT),
    };

    media_resp(
        StatusCode::PARTIAL_CONTENT,
        mime,
        &[
            ("Content-Length", body.len().to_string()),
            ("Content-Range", format!("bytes {start}-{end}/{len}")),
        ],
        body,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_open_ended_clamps_to_file_end() {
        assert_eq!(parse_range(Some("bytes=0-"), 100).unwrap(), Some((0, 99)));
        assert_eq!(parse_range(Some("bytes=50-"), 100).unwrap(), Some((50, 99)));
        assert_eq!(parse_range(Some(" bytes=0- "), 100).unwrap(), Some((0, 99)));
    }

    #[test]
    fn range_closed_and_suffix() {
        assert_eq!(
            parse_range(Some("bytes=10-19"), 100).unwrap(),
            Some((10, 19))
        );
        // 闭区间越界收敛到文件尾
        assert_eq!(
            parse_range(Some("bytes=10-999"), 100).unwrap(),
            Some((10, 99))
        );
        // 后缀区间：最后 N 字节；超长后缀收敛到整个文件
        assert_eq!(parse_range(Some("bytes=-30"), 100).unwrap(), Some((70, 99)));
        assert_eq!(parse_range(Some("bytes=-999"), 100).unwrap(), Some((0, 99)));
        // 多区间取第一个
        assert_eq!(
            parse_range(Some("bytes=0-9,20-29"), 100).unwrap(),
            Some((0, 9))
        );
    }

    #[test]
    fn range_invalid_is_ignored_unsatisfiable_is_416() {
        assert_eq!(parse_range(None, 100).unwrap(), None);
        assert_eq!(parse_range(Some("bytes=abc"), 100).unwrap(), None);
        assert_eq!(parse_range(Some("bytes=-"), 100).unwrap(), None);
        assert_eq!(parse_range(Some("bytes=-0"), 100).unwrap(), None);
        assert_eq!(parse_range(Some("bytes=5-2"), 100).unwrap(), None);
        assert_eq!(parse_range(Some("items=0-1"), 100).unwrap(), None);
        // 起点越过文件尾 → 不可满足
        assert!(parse_range(Some("bytes=100-"), 100).is_err());
        assert!(parse_range(Some("bytes=100-200"), 100).is_err());
    }

    #[test]
    fn path_only_accepts_v_slash_hash_slash_index() {
        let h = "a1B2c3D4e5F6a7B8c9D0e1F2a3B4c5D6e7F8a9b0";
        assert_eq!(
            parse_path(&format!("/v/{h}/3")),
            Some((h.to_ascii_lowercase(), 3))
        );
        assert_eq!(
            parse_path(&format!("/v/{h}/0/")),
            Some((h.to_ascii_lowercase(), 0))
        );
        // 目录穿越 / 坏 hash / 非数字下标 / 错误前缀
        assert_eq!(parse_path("/v/../../etc"), None);
        assert_eq!(parse_path("/v/short/1"), None);
        assert_eq!(parse_path(&format!("/v/{h}/x")), None);
        assert_eq!(parse_path(&format!("/w/{h}/1")), None);
        assert_eq!(parse_path("/v"), None);
    }

    #[test]
    fn mime_covers_common_containers() {
        assert_eq!(
            video_mime("[SubGroup] Ep01 [1080p].mkv"),
            "video/x-matroska"
        );
        assert_eq!(video_mime("EP01.MP4"), "video/mp4");
        assert_eq!(video_mime("ep.ts"), "video/mp2t");
        assert_eq!(video_mime("noext"), "application/octet-stream");
    }
}
