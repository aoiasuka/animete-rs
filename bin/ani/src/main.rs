#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cache;
mod commands;
mod settings;
mod state;

use state::AppContext;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "warn,ani=info".into()),
        )
        .try_init()
        .ok();

    tauri::Builder::default()
        // 单实例：二次启动时唤起已有窗口（对应 Ani 的 WindowsSingleInstanceChecker）
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .setup(|app| {
            let ctx =
                tauri::async_runtime::block_on(AppContext::build()).map_err(|e| e.to_string())?;
            app.manage(ctx);
            setup_tray(app)?;
            tracing::info!("ani-rs app context built");
            Ok(())
        })
        // 关闭窗口 = 最小化到托盘（BT 下载/做种继续）；真正的退出走托盘菜单
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                let _ = window.app_handle().emit("hidden-to-tray", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::search_subjects,
            commands::episode_list,
            commands::fetch_medias,
            commands::start_torrent,
            commands::get_settings,
            commands::get_calendar,
            commands::list_search_history,
            commands::clear_search_history,
            commands::save_settings,
            commands::reveal_path,
            commands::start_torrent_stream,
            commands::spawn_player,
            commands::save_progress,
            commands::load_progress,
            commands::list_downloads,
            commands::set_download_paused,
            commands::remove_download,
            commands::download_video_path,
            commands::test_source,
            commands::test_jellyfin,
            commands::check_mpv,
            commands::cache_start,
            commands::cache_list,
            commands::cache_delete,
            commands::cache_dir_path,
            commands::danmaku_fetch,
            commands::learn_media_preference,
            commands::bangumi_status,
            commands::bangumi_auth_url,
            commands::bangumi_auth_exchange,
            commands::bangumi_logout,
            commands::bangumi_mark_watched,
            commands::open_url,
            commands::app_quit,
            commands::win_minimize,
            commands::win_toggle_maximize,
            commands::win_close,
            commands::win_is_maximized,
        ])
        // 离线缓存回放：http://anicache.localhost/<id>/<file>（对应 Ani 的本地缓存 MediaSource）
        .register_asynchronous_uri_scheme_protocol("anicache", |_ctx, request, responder| {
            let path = request.uri().path().to_string();
            tauri::async_runtime::spawn(async move {
                responder.respond(cache::serve_file(&path));
            });
        })
        .run(tauri::generate_context!())
        .expect("error while running ani-rs");
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// 托盘：左键点击显示主窗口，右键菜单（显示 / 退出）。
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("ani-rs 追番")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            // 退出挽留交给前端确认（有下载任务时），确认后调 app_quit
            "quit" => {
                let _ = app.emit("app-quit-requested", ());
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}
