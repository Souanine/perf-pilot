use crate::k6::RunOutput;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

/// Run a blocking closure off the tokio runtime so a slow disk read
/// doesn't stall every other in-flight Tauri command. Tauri commands
/// run on the async runtime; doing `std::fs::*` directly inside one
/// blocks the worker thread until the syscall returns.
async fn run_blocking<F, R>(f: F) -> anyhow::Result<R>
where
    F: FnOnce() -> anyhow::Result<R> + Send + 'static,
    R: Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(f).await {
        Ok(inner) => inner,
        Err(e) => Err(anyhow::anyhow!("blocking io task panicked: {}", e)),
    }
}

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
    /// `http_req_duration` p95 in milliseconds, extracted from the k6
    /// summary block at conclude time. Lets the Dashboard render a
    /// p(95) trend chart without re-reading every per-run JSON.
    #[serde(default)]
    pub p95_ms: Option<f64>,
    /// Throughput in requests/second, from `http_reqs` rate.
    #[serde(default)]
    pub rps: Option<f64>,
    /// Error rate as a percentage (0–100), from `http_req_failed`.
    #[serde(default)]
    pub error_rate_pct: Option<f64>,
}

/// Pull p95 / rps / error-rate out of a k6 summary stdout buffer. None
/// of any field if the matching line isn't present (older runs, custom
/// scripts that disable the default metrics, runs that ended before k6
/// flushed the summary block).
pub fn extract_chart_metrics(stdout: &str) -> (Option<f64>, Option<f64>, Option<f64>) {
    (
        extract_p95_ms(stdout),
        extract_rps(stdout),
        extract_error_rate_pct(stdout),
    )
}

use once_cell::sync::Lazy;
use regex::Regex;

static P95_LINE: Lazy<Regex> = Lazy::new(|| {
    // http_req_duration..............: avg=... min=... p(95)=<NN>ms
    Regex::new(r"http_req_duration[^\n]*p\(95\)=([0-9.eE+-]+)(ms|s|µs|us)?").unwrap()
});
static RPS_LINE: Lazy<Regex> = Lazy::new(|| {
    // http_reqs...........: <count> <rate>/s
    Regex::new(r"http_reqs[^\n]*:\s*[0-9]+\s+([0-9.eE+-]+)/s").unwrap()
});
static ERR_LINE: Lazy<Regex> = Lazy::new(|| {
    // http_req_failed......: <rate>% ...
    Regex::new(r"http_req_failed[^\n]*:\s*([0-9.eE+-]+)\s*%").unwrap()
});

fn extract_p95_ms(stdout: &str) -> Option<f64> {
    let caps = P95_LINE.captures(stdout)?;
    let v: f64 = caps.get(1)?.as_str().parse().ok()?;
    let unit = caps.get(2).map(|m| m.as_str()).unwrap_or("ms");
    Some(match unit {
        "s" => v * 1000.0,
        "µs" | "us" => v / 1000.0,
        _ => v,
    })
}

fn extract_rps(stdout: &str) -> Option<f64> {
    let caps = RPS_LINE.captures(stdout)?;
    caps.get(1)?.as_str().parse().ok()
}

fn extract_error_rate_pct(stdout: &str) -> Option<f64> {
    let caps = ERR_LINE.captures(stdout)?;
    caps.get(1)?.as_str().parse().ok()
}

/// Key in `perf-pilot.settings.json` (the frontend-managed store-plugin
/// file) under which a custom scripts directory is persisted. Rust only
/// ever reads this file — the frontend owns writes — so there is no
/// write contention with the store plugin.
const SCRIPTS_DIR_KEY: &str = "scripts.dir";

/// Effective scripts directory: the user's override from the settings
/// JSON if present, else the platform default.
pub fn scripts_dir(app: &tauri::AppHandle) -> anyhow::Result<PathBuf> {
    if let Some(dir) = scripts_dir_override(app) {
        return Ok(dir);
    }
    default_scripts_dir(app)
}

/// `~/.perfpilot` on every platform. Deliberately *not* app_data_dir:
/// that resolves to `~/Library/Application Support/...` on macOS vs
/// `%APPDATA%\...` on Windows, which users can't find. The home dir is
/// the same predictable location everywhere (`C:\Users\<name>\.perfpilot`
/// on Windows).
pub fn default_scripts_dir(app: &tauri::AppHandle) -> anyhow::Result<PathBuf> {
    Ok(app.path().home_dir()?.join(".perfpilot"))
}

fn scripts_dir_override(app: &tauri::AppHandle) -> Option<PathBuf> {
    let file = app.path().app_data_dir().ok()?.join("perf-pilot.settings.json");
    let raw = std::fs::read_to_string(file).ok()?;
    parse_scripts_dir_override(&raw).map(PathBuf::from)
}

/// Split out from `scripts_dir_override` so the JSON parsing is testable
/// without an `AppHandle`. Blank / non-string values mean "no override".
fn parse_scripts_dir_override(raw: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let s = v.get(SCRIPTS_DIR_KEY)?.as_str()?.trim();
    (!s.is_empty()).then(|| s.to_string())
}

pub fn runs_dir(app: &tauri::AppHandle) -> anyhow::Result<PathBuf> {
    let base = app.path().app_data_dir()?;
    Ok(base.join("runs"))
}

pub fn ensure_dirs(app: &tauri::AppHandle) -> anyhow::Result<()> {
    let scripts = scripts_dir(app)?;
    let runs = runs_dir(app)?;
    migrate_legacy_scripts(app, &scripts);
    std::fs::create_dir_all(&scripts)?;
    std::fs::create_dir_all(&runs)?;
    Ok(())
}

/// Pre-0.1.4 builds kept scripts in `<app_data_dir>/scripts`. When the
/// default moved to `~/.perfpilot`, first launch copies any `.js` files
/// from the old location so existing users don't lose their scripts.
/// Best-effort and one-shot: only runs when no override is set and the
/// target doesn't exist yet. The legacy dir is left in place as a backup.
fn migrate_legacy_scripts(app: &tauri::AppHandle, target: &std::path::Path) {
    if scripts_dir_override(app).is_some() || target.exists() {
        return;
    }
    let Ok(legacy) = app.path().app_data_dir().map(|d| d.join("scripts")) else {
        return;
    };
    if legacy == target || !legacy.is_dir() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(&legacy) else {
        return;
    };
    let _ = std::fs::create_dir_all(target);
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("js") {
            continue;
        }
        let dest = target.join(path.file_name().unwrap_or_default());
        if !dest.exists() {
            let _ = std::fs::copy(&path, &dest);
        }
    }
}

pub async fn list_scripts(app: &tauri::AppHandle) -> anyhow::Result<Vec<ScriptFile>> {
    let dir = scripts_dir(app)?;
    run_blocking(move || {
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
                .map(DateTime::<Utc>::from)
                .unwrap_or_else(Utc::now);
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
    })
    .await
}

pub async fn read_script(path: &str) -> anyhow::Result<String> {
    let path = path.to_string();
    run_blocking(move || Ok(std::fs::read_to_string(&path)?)).await
}

pub async fn write_script(
    app: &tauri::AppHandle,
    path: &str,
    content: &str,
) -> anyhow::Result<()> {
    let resolved = resolve_script_path(app, path);
    let content = content.to_string();
    run_blocking(move || {
        if let Some(parent) = resolved.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&resolved, content)?;
        Ok(())
    })
    .await
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

pub async fn delete_script(path: &str) -> anyhow::Result<()> {
    let path = path.to_string();
    run_blocking(move || {
        let p = std::path::Path::new(&path);
        if p.exists() {
            std::fs::remove_file(p)?;
        }
        Ok(())
    })
    .await
}

pub async fn list_runs(app: &tauri::AppHandle) -> anyhow::Result<Vec<RunRecord>> {
    let dir = runs_dir(app)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    // Fast path: read the sidecar index. One small file instead of N
    // JSON parses — keeps the History page snappy even with hundreds of
    // completed runs.
    let cached = run_blocking({
        let dir = dir.clone();
        move || list_records(&dir)
    })
    .await?;
    if !cached.is_empty() {
        return Ok(cached);
    }
    eprintln!("runs index unreadable, rebuilding");
    rebuild_runs_index(app).await
}

/// Walk the runs directory, parse each per-run JSON, and rewrite the
/// index file. Used once at first launch and after a corrupt index.
pub async fn rebuild_runs_index(app: &tauri::AppHandle) -> anyhow::Result<Vec<RunRecord>> {
    let dir = runs_dir(app)?;
    run_blocking(move || {
        let records = scan_dir_for_records(&dir)?;
        std::fs::create_dir_all(&dir)?;
        std::fs::write(
            dir.join(RUNS_INDEX_FILE),
            serde_json::to_string_pretty(&records)?,
        )?;
        Ok(records)
    })
    .await
}

const RUNS_INDEX_FILE: &str = "index.json";

/// Insert or update the entry for `record` in the index file. Called
/// from `k6::conclude_run` after the per-run JSON is persisted.
pub async fn upsert_run_index(app: &tauri::AppHandle, record: &RunRecord) -> anyhow::Result<()> {
    let dir = runs_dir(app)?;
    let record = record.clone();
    run_blocking(move || {
        // If the index is missing or unreadable, rebuild from disk
        // first so we don't accidentally drop concurrent entries.
        if dir.join(RUNS_INDEX_FILE).exists() {
            // Existing index — fall through to merge.
        } else if let Ok(rebuilt) = scan_dir_for_records(&dir) {
            // Cold start with no index — write the scanned records
            // before adding the new entry so we don't throw away
            // other runs.
            for r in &rebuilt {
                upsert_record(&dir, r)?;
            }
        }
        upsert_record(&dir, &record)
    })
    .await
}

/// Drop the entry for `run_id` from the index. Best-effort: a missing
/// index file is silently treated as "already gone".
pub fn remove_run_index(app: &tauri::AppHandle, run_id: &str) -> anyhow::Result<()> {
    remove_record(&runs_dir(app)?, run_id)
}

/// Path-typed variants of the index helpers, factored out so tests can
/// exercise the merge / remove logic without spinning up a Tauri
/// `AppHandle`.
pub(crate) fn upsert_record(
    dir: &std::path::Path,
    record: &RunRecord,
) -> anyhow::Result<()> {
    let path = dir.join(RUNS_INDEX_FILE);
    let mut records: Vec<RunRecord> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    if let Some(slot) = records.iter_mut().find(|r| r.run_id == record.run_id) {
        *slot = record.clone();
    } else {
        records.push(record.clone());
    }
    records.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    std::fs::create_dir_all(dir)?;
    std::fs::write(&path, serde_json::to_string_pretty(&records)?)?;
    Ok(())
}

pub(crate) fn remove_record(dir: &std::path::Path, run_id: &str) -> anyhow::Result<()> {
    let path = dir.join(RUNS_INDEX_FILE);
    if !path.exists() {
        return Ok(());
    }
    let mut records: Vec<RunRecord> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    let before = records.len();
    records.retain(|r| r.run_id != run_id);
    if records.len() != before {
        std::fs::write(&path, serde_json::to_string_pretty(&records)?)?;
    }
    Ok(())
}

pub(crate) fn list_records(dir: &std::path::Path) -> anyhow::Result<Vec<RunRecord>> {
    let path = dir.join(RUNS_INDEX_FILE);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(&path)?;
    let mut records: Vec<RunRecord> = serde_json::from_str(&raw)?;
    records.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(records)
}

/// Walk the runs directory and turn every per-run JSON into a
/// `RunRecord`. Used by `rebuild_runs_index` and as the cold-start path
/// for the index when no sidecar exists yet.
fn scan_dir_for_records(dir: &std::path::Path) -> anyhow::Result<Vec<RunRecord>> {
    let mut out = Vec::new();
    if !dir.exists() {
        return Ok(out);
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        if path.file_name().and_then(|s| s.to_str()) == Some(RUNS_INDEX_FILE) {
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
        let (p95_ms, rps, error_rate_pct) = extract_chart_metrics(&parsed.stdout);
        out.push(RunRecord {
            run_id: parsed.run_id.clone(),
            label: parsed.label.clone(),
            status: parsed.status.clone(),
            started_at: parsed.started_at,
            finished_at: parsed.finished_at,
            exit_code: parsed.exit_code,
            script_path: parsed.script_path.clone(),
            p95_ms,
            rps,
            error_rate_pct,
        });
    }
    out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(out)
}

pub async fn load_run_output(app: &tauri::AppHandle, run_id: &str) -> anyhow::Result<RunOutput> {
    let path = runs_dir(app)?.join(format!("{}.json", run_id));
    run_blocking(move || {
        let raw = std::fs::read_to_string(&path)?;
        Ok(serde_json::from_str(&raw)?)
    })
    .await
}

pub async fn delete_run(app: &tauri::AppHandle, run_id: &str) -> anyhow::Result<()> {
    let run_path = runs_dir(app)?.join(format!("{}.json", run_id));
    let report_dir = reports_dir(app)?;
    let run_id_owned = run_id.to_string();
    run_blocking(move || {
        if run_path.exists() {
            std::fs::remove_file(&run_path)?;
        }
        // Drop any associated report so a re-run starts clean.
        let report = report_dir.join(format!("{}.md", &run_id_owned));
        if report.exists() {
            let _ = std::fs::remove_file(&report);
        }
        // Keep the index in sync — list_runs reads it, so a stale
        // entry would still surface a run that's been deleted on disk.
        let _ = remove_record(&run_path.parent().unwrap_or(&report_dir), &run_id_owned);
        Ok(())
    })
    .await
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
pub async fn write_report(
    app: &tauri::AppHandle,
    run_id: &str,
    markdown: &str,
    model: Option<&str>,
) -> anyhow::Result<ReportRecord> {
    let dir = ensure_reports_dir(app)?;
    let path = dir.join(format!("{}.md", run_id));
    let meta_path = dir.join(format!("{}.meta.json", run_id));
    let markdown = markdown.to_string();
    let model = model.map(|s| s.to_string());
    let run_id_owned = run_id.to_string();
    let created_at = Utc::now();

    let size = markdown.len() as u64;
    let written_path = path.to_string_lossy().to_string();
    let model_for_closure = model.clone();

    run_blocking(move || {
        std::fs::write(&path, &markdown)?;
        // Sidecar JSON so we can list reports without re-parsing markdown.
        let meta = serde_json::json!({
            "run_id": run_id_owned,
            "model": model_for_closure,
            "created_at": created_at,
        });
        let _ = std::fs::write(
            &meta_path,
            serde_json::to_string_pretty(&meta).unwrap_or_default(),
        );
        Ok(())
    })
    .await?;

    Ok(ReportRecord {
        run_id: run_id.to_string(),
        path: written_path,
        model,
        created_at,
        size,
    })
}

pub async fn read_report(app: &tauri::AppHandle, run_id: &str) -> anyhow::Result<String> {
    let path = reports_dir(app)?.join(format!("{}.md", run_id));
    run_blocking(move || std::fs::read_to_string(&path).map_err(Into::into)).await
}

pub async fn list_reports(app: &tauri::AppHandle) -> anyhow::Result<Vec<ReportRecord>> {
    let dir = reports_dir(app)?;
    run_blocking(move || {
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
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn rec(id: &str, sec: i64) -> RunRecord {
        RunRecord {
            run_id: id.to_string(),
            label: Some(format!("label-{id}")),
            status: "passed".to_string(),
            started_at: Utc.timestamp_opt(sec, 0).unwrap(),
            finished_at: Some(Utc.timestamp_opt(sec + 1, 0).unwrap()),
            exit_code: Some(0),
            script_path: format!("/tmp/{id}.js"),
            p95_ms: None,
            rps: None,
            error_rate_pct: None,
        }
    }

    fn tmpdir(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "perf-pilot-fs-test-{}-{}",
            label,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn upsert_record_inserts_then_replaces() {
        let dir = tmpdir("upsert");
        upsert_record(&dir, &rec("a", 100)).unwrap();
        upsert_record(&dir, &rec("a", 100)).unwrap();
        upsert_record(&dir, &rec("b", 200)).unwrap();
        let records = list_records(&dir).unwrap();
        assert_eq!(records.len(), 2);
        // Newest first.
        assert_eq!(records[0].run_id, "b");
        assert_eq!(records[1].run_id, "a");
    }

    #[test]
    fn remove_record_drops_matching_id_only() {
        let dir = tmpdir("remove");
        upsert_record(&dir, &rec("a", 100)).unwrap();
        upsert_record(&dir, &rec("b", 200)).unwrap();
        upsert_record(&dir, &rec("c", 300)).unwrap();
        remove_record(&dir, "b").unwrap();
        let records = list_records(&dir).unwrap();
        let ids: Vec<_> = records.iter().map(|r| r.run_id.as_str()).collect();
        assert_eq!(ids, vec!["c", "a"]);
    }

    #[test]
    fn remove_record_no_op_when_index_missing() {
        let dir = tmpdir("missing");
        // Should not panic / error even though the index file doesn't exist.
        remove_record(&dir, "anything").unwrap();
        assert!(!dir.join(RUNS_INDEX_FILE).exists());
    }

    #[test]
    fn list_records_empty_when_no_index() {
        let dir = tmpdir("listempty");
        let records = list_records(&dir).unwrap();
        assert!(records.is_empty());
    }

    #[test]
    fn parse_scripts_dir_override_reads_key() {
        assert_eq!(
            parse_scripts_dir_override(r#"{"scripts.dir":"/tmp/pp-scripts"}"#).as_deref(),
            Some("/tmp/pp-scripts")
        );
        // Whitespace is trimmed but content kept.
        assert_eq!(
            parse_scripts_dir_override(r#"{"scripts.dir":"  /x  "}"#).as_deref(),
            Some("/x")
        );
    }

    #[test]
    fn parse_scripts_dir_override_absent_or_blank_is_none() {
        assert_eq!(parse_scripts_dir_override("{}"), None);
        assert_eq!(parse_scripts_dir_override(r#"{"scripts.dir":""}"#), None);
        assert_eq!(parse_scripts_dir_override(r#"{"scripts.dir":"   "}"#), None);
        assert_eq!(parse_scripts_dir_override(r#"{"scripts.dir":42}"#), None);
        assert_eq!(parse_scripts_dir_override("not json"), None);
    }

    const K6_SUMMARY: &str = "\
          execution: local
         script: /x/a.js
          output: -

     scenarios: (100.00%) 1 scenario, 50 max VUs, 2m30s max duration (incl. graceful stop):
              * default (100.00%) [1 Iterations] [1 Shared Iterations]
                                                          [depleted]

     data_received..............: 150 kB 2.5 kB/s
     http_req_blocked...........: avg=12.5ms  min=10ms  med=11ms   max=20ms   p(90)=15ms    p(95)=18ms
     http_req_connecting........: avg=10ms    min=8ms   med=9ms    max=15ms   p(90)=12ms    p(95)=14ms
     http_req_duration..........: avg=120.45ms min=80ms med=110ms max=300ms p(90)=180ms p(95)=210ms p(99)=250ms
     http_req_failed............: 0.00%   0 out of 532
     http_req_receiving.........: avg=1ms     min=0s    med=1ms    max=5ms    p(90)=2ms     p(95)=3ms
     http_req_sending...........: avg=0.5ms   min=0s    med=0.5ms  max=2ms    p(90)=1ms     p(95)=1.5ms
     http_req_tls_handshaking...: avg=5ms     min=4ms   med=5ms    max=10ms   p(90)=6ms     p(95)=7ms
     http_req_waiting...........: avg=119ms   min=78ms  med=108ms  max=295ms  p(90)=177ms   p(95)=208ms
     http_reqs..................: 532    53.2/s
     iteration_duration.........: avg=240ms   min=160ms med=220ms  max=600ms  p(90)=360ms   p(95)=420ms
     iterations.................: 100    10/s
     vus........................: 50     min=0     max=50
     vus_max....................: 50     min=50    max=50

running (2m30s), 00/50 VUs, 100 complete and 0 interrupted iterations
default ✓ [ 100% ] 100/100 shared iterations
     .................... data_received..........: 150 kB 2.5 kB/s
";

    #[test]
    fn extract_chart_metrics_parses_p95_ms() {
        let (p95, _, _) = extract_chart_metrics(K6_SUMMARY);
        assert_eq!(p95, Some(210.0));
    }

    #[test]
    fn extract_chart_metrics_parses_rps() {
        let (_, rps, _) = extract_chart_metrics(K6_SUMMARY);
        assert_eq!(rps, Some(53.2));
    }

    #[test]
    fn extract_chart_metrics_parses_error_rate() {
        let (_, _, err) = extract_chart_metrics(K6_SUMMARY);
        assert_eq!(err, Some(0.00));
    }

    #[test]
    fn extract_chart_metrics_handles_missing_lines() {
        let (p95, rps, err) = extract_chart_metrics("no k6 summary here\n");
        assert!(p95.is_none());
        assert!(rps.is_none());
        assert!(err.is_none());
    }
}