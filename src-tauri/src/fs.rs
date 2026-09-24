use crate::k6::RunOutput;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScriptFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RunRecord {
    pub run_id: String,
    pub label: Option<String>,
    pub status: String,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub exit_code: Option<i32>,
    pub script_path: String,
}

pub fn scripts_dir(app: &tauri::AppHandle) -> anyhow::Result<PathBuf> {
    let base = app.path().app_data_dir()?;
    Ok(base.join("scripts"))
}

pub fn runs_dir(app: &tauri::AppHandle) -> anyhow::Result<PathBuf> {
    let base = app.path().app_data_dir()?;
    Ok(base.join("runs"))
}

pub fn ensure_dirs(app: &tauri::AppHandle) -> anyhow::Result<()> {
    let scripts = scripts_dir(app)?;
    let runs = runs_dir(app)?;
    std::fs::create_dir_all(&scripts)?;
    std::fs::create_dir_all(&runs)?;
    Ok(())
}

pub fn list_scripts(app: &tauri::AppHandle) -> anyhow::Result<Vec<ScriptFile>> {
    let dir = scripts_dir(app)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("js") {
            continue;
        }
        let meta = entry.metadata()?;
        let modified = meta
            .modified()
            .ok()
            .and_then(|m| Some(DateTime::<Utc>::from(m)))
            .unwrap_or_else(|| Utc::now());
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        out.push(ScriptFile {
            path: path.to_string_lossy().to_string(),
            name,
            size: meta.len(),
            modified_at: modified,
        });
    }
    out.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Ok(out)
}

pub fn read_script(path: &str) -> anyhow::Result<String> {
    Ok(std::fs::read_to_string(path)?)
}

pub fn write_script(app: &tauri::AppHandle, path: &str, content: &str) -> anyhow::Result<()> {
    let resolved = resolve_script_path(app, path);
    if let Some(parent) = resolved.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&resolved, content)?;
    Ok(())
}

/// If `path` is absolute, use it as-is. Otherwise anchor it to the
/// app data scripts dir so files always land in the expected location
/// even if the frontend sends a bare filename.
pub fn resolve_script_path(app: &tauri::AppHandle, path: &str) -> std::path::PathBuf {
    let p = std::path::Path::new(path);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        scripts_dir(app)
            .unwrap_or_else(|_| std::path::PathBuf::from("."))
            .join(path)
    }
}

pub fn delete_script(path: &str) -> anyhow::Result<()> {
    let p = std::path::Path::new(path);
    if p.exists() {
        std::fs::remove_file(p)?;
    }
    Ok(())
}

pub fn list_runs(app: &tauri::AppHandle) -> anyhow::Result<Vec<RunRecord>> {
    let dir = runs_dir(app)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let raw = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let parsed: RunOutput = match serde_json::from_str(&raw) {
            Ok(r) => r,
            Err(_) => continue,
        };
        out.push(RunRecord {
            run_id: parsed.run_id.clone(),
            label: parsed.label.clone(),
            status: parsed.status.clone(),
            started_at: parsed.started_at,
            finished_at: parsed.finished_at,
            exit_code: parsed.exit_code,
            script_path: parsed.script_path.clone(),
        });
    }
    out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(out)
}

pub fn load_run_output(app: &tauri::AppHandle, run_id: &str) -> anyhow::Result<RunOutput> {
    let path = runs_dir(app)?.join(format!("{}.json", run_id));
    let raw = std::fs::read_to_string(&path)?;
    Ok(serde_json::from_str(&raw)?)
}

pub fn delete_run(app: &tauri::AppHandle, run_id: &str) -> anyhow::Result<()> {
    let path = runs_dir(app)?.join(format!("{}.json", run_id));
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    Ok(())
}