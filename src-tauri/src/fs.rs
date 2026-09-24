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
    // Drop any associated report so a re-run starts clean.
    let report = reports_dir(app)?.join(format!("{}.md", run_id));
    if report.exists() {
        let _ = std::fs::remove_file(&report);
    }
    Ok(())
}

/// Per-run generated markdown report, surfaced in the History page.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ReportRecord {
    pub run_id: String,
    pub path: String,
    pub model: Option<String>,
    pub created_at: DateTime<Utc>,
    pub size: u64,
}

pub fn reports_dir(app: &tauri::AppHandle) -> anyhow::Result<PathBuf> {
    let base = app.path().app_data_dir()?;
    Ok(base.join("reports"))
}

pub fn ensure_reports_dir(app: &tauri::AppHandle) -> anyhow::Result<PathBuf> {
    let dir = reports_dir(app)?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Persist a generated report markdown file for `run_id`. Overwrites any
/// previous report for the same run so re-generation is idempotent.
pub fn write_report(
    app: &tauri::AppHandle,
    run_id: &str,
    markdown: &str,
    model: Option<&str>,
) -> anyhow::Result<ReportRecord> {
    let dir = ensure_reports_dir(app)?;
    let path = dir.join(format!("{}.md", run_id));
    std::fs::write(&path, markdown)?;

    // Sidecar JSON sidecar so we can list reports without re-parsing markdown.
    let meta_path = dir.join(format!("{}.meta.json", run_id));
    let meta = serde_json::json!({
        "run_id": run_id,
        "model": model,
        "created_at": Utc::now(),
    });
    let _ = std::fs::write(
        &meta_path,
        serde_json::to_string_pretty(&meta).unwrap_or_default(),
    );

    Ok(ReportRecord {
        run_id: run_id.to_string(),
        path: path.to_string_lossy().to_string(),
        model: model.map(|s| s.to_string()),
        created_at: Utc::now(),
        size: markdown.len() as u64,
    })
}

pub fn read_report(app: &tauri::AppHandle, run_id: &str) -> anyhow::Result<String> {
    let path = reports_dir(app)?.join(format!("{}.md", run_id));
    Ok(std::fs::read_to_string(&path)?)
}

pub fn list_reports(app: &tauri::AppHandle) -> anyhow::Result<Vec<ReportRecord>> {
    let dir = reports_dir(app)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let meta = entry.metadata().ok();
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let run_id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();

        // Pull model + created_at from the sidecar if it exists.
        let sidecar = dir.join(format!("{}.meta.json", run_id));
        let (model, created_at) = match std::fs::read_to_string(&sidecar)
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        {
            Some(v) => (
                v.get("model").and_then(|x| x.as_str()).map(|s| s.to_string()),
                v.get("created_at")
                    .and_then(|x| x.as_str())
                    .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                    .map(|d| d.with_timezone(&Utc))
                    .unwrap_or_else(|| {
                        meta.as_ref()
                            .and_then(|m| m.modified().ok())
                            .map(DateTime::<Utc>::from)
                            .unwrap_or_else(Utc::now)
                    }),
            ),
            None => (
                None,
                meta.as_ref()
                    .and_then(|m| m.modified().ok())
                    .map(DateTime::<Utc>::from)
                    .unwrap_or_else(Utc::now),
            ),
        };

        out.push(ReportRecord {
            run_id,
            path: path.to_string_lossy().to_string(),
            model,
            created_at,
            size,
        });
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}