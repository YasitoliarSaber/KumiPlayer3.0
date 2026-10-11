use std::process::Command;

use tauri::State;

mod runtime_identity;
pub use runtime_identity::{backend_is_compatible, runtime_id_for};
mod api_session;
mod backend_job;
mod desktop;
mod desktop_lifecycle;
mod supervisor;
mod window_preferences;
pub use supervisor::{
    data_dir_for, existing_backend_error, health_matches, protect_backend, restart_backend_with,
    start_backend, stop_backend, wait_for_health, BackendProcess, BackendSupervisor, HealthTimings,
    ManagedBackend, RestartTimings, RuntimeContext, SystemSupervisor, BACKEND_HOST, BACKEND_PORT,
    PORT_RELEASE_TIMEOUT, RESTART_HEALTH_TIMINGS, STARTUP_HEALTH_TIMINGS,
};

struct ApiSession(String);

#[tauri::command]
fn get_api_token(session: State<'_, ApiSession>) -> String {
    session.0.clone()
}

#[tauri::command]
async fn restart_backend(app: tauri::AppHandle) -> Result<(), String> {
    desktop::restart_backend(app).await
}

#[tauri::command]
fn open_log_directory(context: State<'_, RuntimeContext>) -> Result<(), String> {
    let log_dir = data_dir_for(context.inner())?.join("logs").join("error");
    std::fs::create_dir_all(&log_dir).map_err(|error| format!("无法创建日志目录：{error}"))?;
    #[cfg(windows)]
    let mut command = Command::new("explorer.exe");
    #[cfg(not(windows))]
    let mut command = Command::new("xdg-open");
    command
        .arg(&log_dir)
        .spawn()
        .map_err(|error| format!("无法打开日志目录：{error}"))?;
    Ok(())
}

#[tauri::command]
fn save_diagnostics(content: String, context: State<'_, RuntimeContext>) -> Result<String, String> {
    if content.len() > 100_000 {
        return Err("诊断内容超过 100 KB 限制".to_string());
    }
    let diagnostics_dir = data_dir_for(context.inner())?
        .join("logs")
        .join("diagnostics");
    std::fs::create_dir_all(&diagnostics_dir)
        .map_err(|error| format!("无法创建诊断目录：{error}"))?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let path = diagnostics_dir.join(format!("kumiplayer-diagnostics-{timestamp}.txt"));
    std::fs::write(&path, content.as_bytes())
        .map_err(|error| format!("无法写入诊断文件：{error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    desktop::run();
}
