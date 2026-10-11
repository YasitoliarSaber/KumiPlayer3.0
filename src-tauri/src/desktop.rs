//! 单实例、托盘与异步退出。任何后端等待都不得运行在窗口事件线程。
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use crate::desktop_lifecycle::{Activation, DesktopLifecycle, ShutdownCompletion};
use crate::supervisor::{restart_backend_with_cancel, stop_backend_serialized};
use crate::window_preferences::{WindowPreferences, WindowPreferencesStore};
use crate::{data_dir_for, ApiSession, BackendProcess, RuntimeContext, SystemSupervisor};

#[derive(Default)]
struct LifecycleState(Mutex<DesktopLifecycle>);
struct PreferencesState(Result<WindowPreferencesStore, String>);

fn preferences(app: &AppHandle) -> WindowPreferences {
    app.try_state::<PreferencesState>()
        .and_then(|state| state.0.as_ref().ok().and_then(|store| store.get().ok()))
        .unwrap_or_default()
}

#[tauri::command]
fn get_window_preferences(state: State<'_, PreferencesState>) -> Result<WindowPreferences, String> {
    state.0.as_ref().map_err(Clone::clone)?.get()
}

#[tauri::command]
async fn set_window_preferences(
    app: AppHandle,
    preferences: WindowPreferences,
) -> Result<WindowPreferences, String> {
    if (preferences.minimize_to_tray || preferences.close_to_tray)
        && app.tray_by_id("main").is_none()
    {
        return Err("托盘图标不可用，无法启用收到托盘".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<PreferencesState>();
        state.0.as_ref().map_err(Clone::clone)?.save(preferences)
    })
    .await
    .map_err(|_| "窗口设置保存任务失败".to_string())?
}

#[tauri::command]
fn hide_to_tray(app: AppHandle) -> Result<(), String> {
    if app.tray_by_id("main").is_none() {
        return Err("托盘图标不可用".to_string());
    }
    let window = app.get_webview_window("main").ok_or("主窗口不存在")?;
    window.hide().map_err(|_| "无法隐藏主窗口".to_string())
}

#[tauri::command]
fn minimize_main_window(app: AppHandle) -> Result<(), String> {
    if preferences(&app).minimize_to_tray && app.tray_by_id("main").is_some() {
        hide_to_tray(app)
    } else {
        app.get_webview_window("main")
            .ok_or("主窗口不存在")?
            .minimize()
            .map_err(|_| "无法最小化窗口".to_string())
    }
}

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn activate(app: &AppHandle) {
    let action = app.state::<LifecycleState>().0.lock().unwrap().activate();
    if action == Activation::Show {
        show_window(app);
    }
}

fn generation_is_current(app: &AppHandle, generation: u64) -> bool {
    app.state::<LifecycleState>()
        .0
        .lock()
        .unwrap()
        .is_current_running(generation)
}

fn startup_error(app: &AppHandle, error: String) {
    let handle = app.clone();
    let generation = app.state::<LifecycleState>().0.lock().unwrap().generation();
    app.dialog()
        .message(format!("KumiPlayer 无法启动运行环境。\n\n{error}"))
        .kind(MessageDialogKind::Error)
        .title("KumiPlayer 启动失败")
        .show(move |_| {
            if generation_is_current(&handle, generation) {
                handle.exit(1);
            }
        });
}

fn start_worker(app: &AppHandle) {
    let generation = app.state::<LifecycleState>().0.lock().unwrap().generation();
    let handle = app.clone();
    std::thread::spawn(move || {
        let result = restart_backend_with_cancel(
            handle.state::<BackendProcess>().inner(),
            handle.state::<RuntimeContext>().inner(),
            &SystemSupervisor,
            || !generation_is_current(&handle, generation),
        );
        let callback = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            if !generation_is_current(&callback, generation) {
                return;
            }
            if let Err(error) = result {
                startup_error(&callback, error);
            }
        });
    });
}

pub(crate) async fn restart_backend(app: AppHandle) -> Result<(), String> {
    let generation = app.state::<LifecycleState>().0.lock().unwrap().generation();
    if !generation_is_current(&app, generation) {
        return Err("应用正在退出，请等待清理完成".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        restart_backend_with_cancel(
            app.state::<BackendProcess>().inner(),
            app.state::<RuntimeContext>().inner(),
            &SystemSupervisor,
            || !generation_is_current(&app, generation),
        )
    })
    .await
    .map_err(|_| "后端重启任务失败".to_string())?
}

fn complete_shutdown(app: &AppHandle, exit_code: i32) {
    let completion = app
        .state::<LifecycleState>()
        .0
        .lock()
        .unwrap()
        .finish_shutdown();
    match completion {
        ShutdownCompletion::Reopen => {
            show_window(app);
            start_worker(app);
        }
        ShutdownCompletion::Exit => app.exit(exit_code),
    }
}

fn begin_shutdown(app: &AppHandle, exit_code: i32) {
    if !app
        .state::<LifecycleState>()
        .0
        .lock()
        .unwrap()
        .begin_shutdown()
    {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        if let Err(error) = stop_backend_serialized(handle.state::<BackendProcess>().inner()) {
            eprintln!("[KumiPlayer] {error}");
        }
        let callback = handle.clone();
        let _ = handle.run_on_main_thread(move || complete_shutdown(&callback, exit_code));
    });
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示 KumiPlayer", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let icon = app
        .default_window_icon()
        .ok_or(tauri::Error::AssetNotFound("应用图标".into()))?;
    TrayIconBuilder::with_id("main")
        .icon(icon.clone())
        .tooltip("KumiPlayer")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => activate(app),
            "quit" => begin_shutdown(app, 0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                activate(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

pub(crate) fn run() {
    tauri::Builder::default()
        // 单实例检查必须先于后端启动，重复启动只负责唤起已有窗口。
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            activate(app)
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(BackendProcess::new(None))
        .manage(LifecycleState::default())
        .invoke_handler(tauri::generate_handler![
            crate::get_api_token,
            crate::restart_backend,
            crate::open_log_directory,
            crate::save_diagnostics,
            get_window_preferences,
            set_window_preferences,
            hide_to_tray,
            minimize_main_window
        ])
        .setup(|app| {
            let (context, error) = match RuntimeContext::discover() {
                Ok(context) => (context, None),
                Err(error) => (RuntimeContext::fallback_for_error_dialog(), Some(error)),
            };
            let store = data_dir_for(&context).and_then(|root| {
                WindowPreferencesStore::load(root.join("window-preferences.json"))
            });
            app.manage(PreferencesState(store));
            app.manage(ApiSession(context.api_token().to_string()));
            app.manage(context);
            if let Err(error) = create_tray(app.handle()) {
                eprintln!("[KumiPlayer] 托盘初始化失败：{error}");
            }
            if let Some(error) = error {
                startup_error(app.handle(), error);
            } else {
                start_worker(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            let app = window.app_handle();
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    if preferences(app).close_to_tray && app.tray_by_id("main").is_some() {
                        let _ = hide_to_tray(app.clone());
                    } else {
                        begin_shutdown(app, 0);
                    }
                }
                WindowEvent::Resized(_)
                    if preferences(app).minimize_to_tray
                        && window.is_minimized().unwrap_or(false) =>
                {
                    let _ = hide_to_tray(app.clone());
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::ExitRequested { api, code, .. } = event {
                let state = app.state::<LifecycleState>();
                let lifecycle = state.0.lock().unwrap();
                if lifecycle.allow_exit() {
                    return;
                }
                api.prevent_exit();
                let finished = lifecycle.cleanup_finished();
                drop(lifecycle);
                if finished {
                    // 清理结束到真正退出之间收到的再次启动也必须处理。
                    complete_shutdown(app, code.unwrap_or(0));
                } else {
                    begin_shutdown(app, code.unwrap_or(0));
                }
            }
        });
}
