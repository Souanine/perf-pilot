use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{Manager, State};
use tokio::sync::Mutex;

pub mod fs;
pub mod k6;
pub mod llm;
pub mod llm_stream;
pub mod settings;

use k6::{K6Info, K6Runner, RunOptions, RunOutput};
use llm::{ChatMessage, LlmProviderConfig, ReportGenRequest, ReportGenResponse, ScriptGenRequest, ScriptGenResponse};
use llm_stream::{generate_report_stream as do_generate_report_stream, generate_script_stream as do_generate_script_stream};

/// Shared application state.
pub struct AppState {
    pub runners: Arc<Mutex<Vec<K6Runner>>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppInfo {
    pub app_version: String,
    pub k6_info: Option<K6Info>,
    pub app_data_dir: String,
    pub scripts_dir: String,
    pub runs_dir: String,
}

#[tauri::command]
async fn get_app_info(_state: State<'_, AppState>, app_handle: tauri::AppHandle) -> Result<AppInfo, String> {
    let k6_info = k6::probe_k6().await.ok();
    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    Ok(AppInfo {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        k6_info,
        app_data_dir: base.to_string_lossy().to_string(),
        scripts_dir: fs::scripts_dir(&app_handle)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        runs_dir: fs::runs_dir(&app_handle)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
    })
}

#[tauri::command]
async fn ensure_dirs(app_handle: tauri::AppHandle) -> Result<(), String> {
    fs::ensure_dirs(&app_handle).map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_scripts(app_handle: tauri::AppHandle) -> Result<Vec<fs::ScriptFile>, String> {
    fs::list_scripts(&app_handle).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_script(path: String) -> Result<String, String> {
    fs::read_script(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn write_script(app_handle: tauri::AppHandle, path: String, content: String) -> Result<(), String> {
    fs::write_script(&app_handle, &path, &content).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_script(path: String) -> Result<(), String> {
    fs::delete_script(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn run_k6(
    state: State<'_, AppState>,
    window: tauri::Window,
    run_id: String,
    script_path: String,
    options: RunOptions,
) -> Result<String, String> {
    let runners_ref = state.runners.clone();
    let last_idx = {
        let mut guard = runners_ref.lock().await;
        guard.push(K6Runner::new(run_id.clone(), script_path, options));
        guard.len() - 1
    };

    // Phase 1: prepare. On failure, drop the placeholder we just pushed and
    // surface the error to the caller.
    let prepared = match K6Runner::prepare_run(runners_ref.clone(), last_idx, window.clone()).await
    {
        Ok(p) => p,
        Err(e) => {
            runners_ref.lock().await.retain(|r| r.run_id != run_id);
            return Err(e);
        }
    };

    // Phase 2 + 3 run in the background. We hand the prepared child over to
    // stream_run and persist via conclude_run when k6 exits.
    let app_handle = window.app_handle().clone();
    let run_id_inner = run_id.clone();
    tauri::async_runtime::spawn(async move {
        let conclusion = K6Runner::stream_run(prepared, window).await;
        K6Runner::conclude_run(&app_handle, runners_ref, &run_id_inner, conclusion).await;
    });

    Ok(run_id)
}

#[tauri::command]
async fn stop_k6(state: State<'_, AppState>, run_id: String) -> Result<bool, String> {
    let mut runners = state.runners.lock().await;
    if let Some(runner) = runners.iter_mut().find(|r| r.run_id == run_id) {
        runner.stop().await;
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
async fn list_runs(app_handle: tauri::AppHandle) -> Result<Vec<fs::RunRecord>, String> {
    fs::list_runs(&app_handle).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_run_output(app_handle: tauri::AppHandle, run_id: String) -> Result<RunOutput, String> {
    fs::load_run_output(&app_handle, &run_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_run(app_handle: tauri::AppHandle, run_id: String) -> Result<(), String> {
    fs::delete_run(&app_handle, &run_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn generate_script(
    provider: LlmProviderConfig,
    request: ScriptGenRequest,
    history: Option<Vec<ChatMessage>>,
) -> Result<ScriptGenResponse, String> {
    llm::generate_script(&provider, &request, history.unwrap_or_default())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn test_llm(provider: LlmProviderConfig) -> Result<llm::LlmTestResult, String> {
    llm::test_provider(&provider)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn generate_report(
    app_handle: tauri::AppHandle,
    provider: LlmProviderConfig,
    request: ReportGenRequest,
) -> Result<ReportGenResponse, String> {
    // Load the run snapshot from disk so we don't depend on the frontend
    // shipping metrics / error / timestamps through the IPC payload.
    let run = fs::load_run_output(&app_handle, &request.run_id)
        .await
        .map_err(|e| format!("Run {} not found: {}", request.run_id, e))?;
    let locale = request.locale.as_deref().unwrap_or("en");
    let resp = llm::generate_report(&provider, &run, locale)
        .await
        .map_err(|e| e.to_string())?;

    // Persist the report next to the run, so the History page can find it
    // without re-calling the LLM.
    fs::write_report(&app_handle, &request.run_id, &resp.report, Some(&resp.model))
        .await
        .map_err(|e| e.to_string())?;

    Ok(resp)
}

#[tauri::command]
async fn list_reports(app_handle: tauri::AppHandle) -> Result<Vec<fs::ReportRecord>, String> {
    fs::list_reports(&app_handle).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn generate_script_stream(
    window: tauri::Window,
    request_id: String,
    provider: LlmProviderConfig,
    request: ScriptGenRequest,
    history: Option<Vec<ChatMessage>>,
) -> Result<ScriptGenResponse, String> {
    let history = history.unwrap_or_default();
    do_generate_script_stream(window, request_id, provider, request, history)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn generate_report_stream(
    window: tauri::Window,
    app_handle: tauri::AppHandle,
    request_id: String,
    provider: LlmProviderConfig,
    request: ReportGenRequest,
) -> Result<ReportGenResponse, String> {
    let run = fs::load_run_output(&app_handle, &request.run_id)
        .await
        .map_err(|e| format!("Run {} not found: {}", request.run_id, e))?;
    let locale = request.locale.as_deref().unwrap_or("en").to_string();
    let resp = do_generate_report_stream(window, request_id, provider, run, locale)
        .await
        .map_err(|e| e.to_string())?;
    // Persist the report next to the run, same as the non-streaming path.
    fs::write_report(&app_handle, &request.run_id, &resp.report, Some(&resp.model))
        .await
        .map_err(|e| e.to_string())?;
    Ok(resp)
}

// `list_reports` doesn't need an adapter; the helper was a dead end.


#[tauri::command]
async fn read_report(app_handle: tauri::AppHandle, run_id: String) -> Result<String, String> {
    fs::read_report(&app_handle, &run_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_report(app_handle: tauri::AppHandle, run_id: String) -> Result<(), String> {
    let path = fs::reports_dir(&app_handle)
        .map_err(|e| e.to_string())?
        .join(format!("{}.md", run_id));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    let meta = fs::reports_dir(&app_handle)
        .map_err(|e| e.to_string())?
        .join(format!("{}.meta.json", run_id));
    if meta.exists() {
        let _ = std::fs::remove_file(&meta);
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            // Resolve the bundled k6 sidecar's expected on-disk path and
            // publish it via env var so `k6::which_k6` picks it up before
            // falling back to PATH. No-op in dev if the binary isn't
            // sitting next to the executable yet.
            k6::publish_sidecar_path_to_env();
            // Ensure data dirs exist on startup.
            let _ = fs::ensure_dirs(&app.handle());
            let _ = fs::ensure_reports_dir(&app.handle());
            app.manage(AppState {
                runners: Arc::new(Mutex::new(Vec::new())),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            ensure_dirs,
            list_scripts,
            read_script,
            write_script,
            delete_script,
            run_k6,
            stop_k6,
            list_runs,
            get_run_output,
            delete_run,
            generate_script,
            generate_script_stream,
            test_llm,
            generate_report,
            generate_report_stream,
            list_reports,
            read_report,
            delete_report,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}