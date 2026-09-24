use crate::fs;
use chrono::{DateTime, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::oneshot;
use tokio::sync::Mutex as AsyncMutex;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct K6Info {
    pub version: String,
    pub path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RunOptions {
    /// Display name / scenario label.
    #[serde(default)]
    pub label: Option<String>,
    /// Extra env vars passed to k6 (e.g. {"BASE_URL":"https://..."}).
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
    /// CLI overrides passed after `k6 run`.
    #[serde(default)]
    pub cli_args: Vec<String>,
    /// Duration cap in seconds (0 = no cap, pass-through).
    #[serde(default)]
    pub max_duration_seconds: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MetricSummary {
    pub name: String,
    pub value: String,
    pub unit: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RunOutput {
    pub run_id: String,
    pub script_path: String,
    pub label: Option<String>,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub exit_code: Option<i32>,
    pub status: String, // "running" | "passed" | "failed" | "stopped" | "errored"
    pub stdout: String,
    pub stderr: String,
    pub metrics: Vec<MetricSummary>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RunEvent {
    Started {
        run_id: String,
        started_at: DateTime<Utc>,
        k6_version: String,
        command: Vec<String>,
    },
    Stdout {
        run_id: String,
        line: String,
    },
    Stderr {
        run_id: String,
        line: String,
    },
    Metric {
        run_id: String,
        metric: MetricSummary,
    },
    Finished {
        run_id: String,
        finished_at: DateTime<Utc>,
        exit_code: Option<i32>,
        status: String,
        error: Option<String>,
    },
}

#[derive(Debug)]
pub struct K6Runner {
    pub run_id: String,
    pub script_path: String,
    pub options: RunOptions,
    /// Sender used to request graceful termination.
    cancel: Option<oneshot::Sender<()>>,
    started_at: DateTime<Utc>,
    child_pid: Option<u32>,
}

/// Output of phase 1: a k6 child process has been spawned, but no streaming
/// or waiting has happened yet. The cancel channel is held by the
/// `K6Runner` in the registry; this struct hands the receiver off to phase 2
/// where it gets wired into a cancel watcher.
pub(crate) struct PreparedRun {
    pub(crate) run_id: String,
    pub(crate) child: Child,
    pub(crate) cancel_rx: oneshot::Receiver<()>,
}

/// Output of phase 2: k6 has exited, all streams are joined, all events have
/// been emitted. The final RunOutput has not been persisted yet.
pub(crate) struct RunConclude {
    pub(crate) status: String,
    pub(crate) exit_code: Option<i32>,
    pub(crate) error: Option<String>,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

impl K6Runner {
    pub fn new(run_id: String, script_path: String, options: RunOptions) -> Self {
        Self {
            run_id,
            script_path,
            options,
            cancel: None,
            started_at: Utc::now(),
            child_pid: None,
        }
    }

    pub async fn stop(&mut self) {
        if let Some(tx) = self.cancel.take() {
            let _ = tx.send(());
        }
    }

    /// Phase 1: resolve the k6 binary, snapshot runner state, register the
    /// cancel channel, build the `Command`, emit `RunEvent::Started`, and
    /// spawn the child. Returns the spawned `Child` and its cancel receiver
    /// for phase 2. On failure, emits `RunEvent::Finished { status: "errored" }`
    /// and returns Err.
    pub(crate) async fn prepare_run(
        runners: Arc<AsyncMutex<Vec<K6Runner>>>,
        idx: usize,
        window: tauri::Window,
    ) -> Result<PreparedRun, String> {
        // Snapshot runner state from the shared vector.
        let (run_id, _script_path, options, started_at, target_idx) = {
            let guard = runners.lock().await;
            let r = match guard.get(idx) {
                Some(r) => r,
                None => return Err(format!("runner index {} not found", idx)),
            };
            (
                r.run_id.clone(),
                r.script_path.clone(),
                r.options.clone(),
                r.started_at,
                idx,
            )
        };

        // Register the cancel sender on the runner in a fresh critical section.
        let (cancel_tx, cancel_rx) = oneshot::channel();
        {
            let mut guard = runners.lock().await;
            if let Some(r) = guard.get_mut(target_idx) {
                r.cancel = Some(cancel_tx);
            }
        }

        let k6_path = which_k6().unwrap_or_else(|| "k6".to_string());
        let k6_version = read_k6_version(&k6_path).unwrap_or_else(|_| "unknown".to_string());

        let args = build_k6_args(&options);
        let env = merge_env(&options);
        let mut command_vec: Vec<String> = vec![k6_path.clone()];
        command_vec.extend(args.iter().cloned());

        let _ = window.emit(
            "k6://event",
            RunEvent::Started {
                run_id: run_id.clone(),
                started_at,
                k6_version,
                command: command_vec,
            },
        );

        let mut cmd = Command::new(&k6_path);
        cmd.args(&args)
            .envs(&env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if options.max_duration_seconds > 0 {
            cmd.kill_on_drop(true);
        }

        let child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let err = format!("Failed to spawn k6: {}", e);
                let _ = window.emit(
                    "k6://event",
                    RunEvent::Finished {
                        run_id: run_id.clone(),
                        finished_at: Utc::now(),
                        exit_code: None,
                        status: "errored".to_string(),
                        error: Some(err.clone()),
                    },
                );
                return Err(err);
            }
        };

        // Record the child pid so `stop()` can attempt termination.
        if let Some(pid) = child.id() {
            let mut guard = match runners.try_lock() {
                Ok(g) => g,
                Err(_) => return Err("lock contended while recording child pid".to_string()),
            };
            if let Some(r) = guard.iter_mut().find(|r| r.run_id == run_id) {
                r.child_pid = Some(pid);
            }
        }

        Ok(PreparedRun {
            run_id,
            child,
            cancel_rx,
        })
    }

    /// Phase 2: stream stdout/stderr, parse metrics, watch the cancel
    /// channel, wait for the child to exit, and emit `RunEvent::Finished`.
    /// Returns the aggregated stdout/stderr for phase 3 to persist.
    pub(crate) async fn stream_run(
        prepared: PreparedRun,
        window: tauri::Window,
    ) -> RunConclude {
        let PreparedRun {
            run_id,
            mut child,
            cancel_rx,
        } = prepared;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let stdout_buf = Arc::new(StdMutex::new(String::new()));
        let stderr_buf = Arc::new(StdMutex::new(String::new()));
        let metrics_acc = Arc::new(StdMutex::new(Vec::<MetricSummary>::new()));

        // Stream stdout
        let stdout_task = if let Some(stdout) = stdout {
            let win = window.clone();
            let buf = stdout_buf.clone();
            let metrics = metrics_acc.clone();
            let run_id_inner = run_id.clone();
            Some(tauri::async_runtime::spawn(async move {
                let mut reader = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    {
                        let mut g = buf.lock().unwrap();
                        g.push_str(&line);
                        g.push('\n');
                    }
                    if let Some(m) = parse_metric(&line) {
                        metrics.lock().unwrap().push(m.clone());
                        let _ = win.emit(
                            "k6://event",
                            RunEvent::Metric {
                                run_id: run_id_inner.clone(),
                                metric: m,
                            },
                        );
                    }
                    let _ = win.emit(
                        "k6://event",
                        RunEvent::Stdout {
                            run_id: run_id_inner.clone(),
                            line,
                        },
                    );
                }
            }))
        } else {
            None
        };

        // Stream stderr
        let stderr_task = if let Some(stderr) = stderr {
            let win = window.clone();
            let buf = stderr_buf.clone();
            let run_id_inner = run_id.clone();
            Some(tauri::async_runtime::spawn(async move {
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    buf.lock().unwrap().push_str(&line);
                    buf.lock().unwrap().push('\n');
                    let _ = win.emit(
                        "k6://event",
                        RunEvent::Stderr {
                            run_id: run_id_inner.clone(),
                            line,
                        },
                    );
                }
            }))
        } else {
            None
        };

        // Cancel watcher: when cancel fires, kill the child best-effort.
        let cancel_child_id = child.id();
        let cancel_task = tauri::async_runtime::spawn(async move {
            let _ = cancel_rx.await;
            if let Some(pid) = cancel_child_id {
                let _ = std::process::Command::new("kill")
                    .arg("-TERM")
                    .arg(pid.to_string())
                    .output();
            }
        });
        let _cancel_task = cancel_task;

        let status = child.wait().await;
        if let Some(t) = stdout_task {
            let _ = t.await;
        }
        if let Some(t) = stderr_task {
            let _ = t.await;
        }

        let exit_code = status.as_ref().ok().and_then(|s| s.code());
        let (status_str, error) = match &status {
            Ok(s) if s.success() => ("passed".to_string(), None),
            Ok(s) => {
                let code = s.code().unwrap_or(-1);
                (
                    "failed".to_string(),
                    Some(format!("k6 exited with code {}", code)),
                )
            }
            Err(e) => ("errored".to_string(), Some(format!("wait failed: {}", e))),
        };

        let _ = window.emit(
            "k6://event",
            RunEvent::Finished {
                run_id: run_id.clone(),
                finished_at: Utc::now(),
                exit_code,
                status: status_str.clone(),
                error: error.clone(),
            },
        );

        let stdout_text = stdout_buf.lock().unwrap().clone();
        let stderr_text = stderr_buf.lock().unwrap().clone();

        RunConclude {
            status: status_str,
            exit_code,
            error,
            stdout: stdout_text,
            stderr: stderr_text,
        }
    }

    /// Phase 3: persist the final `RunOutput` JSON and remove the runner from
    /// the registry. After this returns, dropping the `K6Runner` in the
    /// registry will release the cancel sender (if not already consumed).
    pub(crate) async fn conclude_run(
        app_handle: &tauri::AppHandle,
        runners: Arc<AsyncMutex<Vec<K6Runner>>>,
        run_id: &str,
        conclusion: RunConclude,
    ) {
        // Read runner metadata before we drop the entry.
        let (label, script_path, started_at) = {
            let guard = runners.lock().await;
            match guard.iter().find(|r| r.run_id == run_id) {
                Some(r) => (r.options.label.clone(), r.script_path.clone(), r.started_at),
                None => return,
            }
        };

        // Persist RunOutput JSON to the runs directory.
        let runs_dir = match fs::runs_dir(app_handle) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("runs_dir error: {}", e);
                return;
            }
        };
        let out_path = runs_dir.join(format!("{}.json", run_id));
        let stdout_for_parse = conclusion.stdout.clone();
        let metrics = parse_metrics(&stdout_for_parse);
        let output = RunOutput {
            run_id: run_id.to_string(),
            script_path,
            label,
            started_at,
            finished_at: Some(Utc::now()),
            exit_code: conclusion.exit_code,
            status: conclusion.status,
            stdout: conclusion.stdout,
            stderr: conclusion.stderr,
            metrics,
            error: conclusion.error,
        };
        if let Ok(json) = serde_json::to_string_pretty(&output) {
            let _ = std::fs::write(&out_path, json);
        }

        // Drop the runner from the in-memory list.
        let mut guard = match runners.try_lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        guard.retain(|r| r.run_id != run_id);
    }
}

// --- Pure-function helpers (unit-testable, no I/O) --------------------

/// Build the k6 CLI argument vector: passes `options.cli_args` straight
/// through. The "run" subcommand and the script path are added by the
/// caller. Centralised here so future `RunOptions` fields (e.g. setup
/// scripts, env files) can be folded in without touching `prepare_run`.
fn build_k6_args(options: &RunOptions) -> Vec<String> {
    options.cli_args.clone()
}

/// Merge env vars from `RunOptions`. Today this is a passthrough; the seam
/// exists so future defaults (e.g. `K6_NO_COLOR=1`) can land here without
/// changing the call site.
fn merge_env(options: &RunOptions) -> HashMap<String, String> {
    options.env.clone()
}

/// Detect the k6 binary.
pub fn which_k6() -> Option<String> {
    if let Ok(p) = std::env::var("K6_PATH") {
        if std::path::Path::new(&p).exists() {
            return Some(p);
        }
    }
    for candidate in [
        "/opt/homebrew/bin/k6",
        "/usr/local/bin/k6",
        "/usr/bin/k6",
        "C:\\Program Files\\k6\\k6.exe",
    ] {
        if std::path::Path::new(candidate).exists() {
            return Some(candidate.to_string());
        }
    }
    // Fallback: ask the shell to resolve `k6` via PATH.
    if let Ok(out) = std::process::Command::new("sh").args(["-c", "command -v k6"]).output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() {
                return Some(s);
            }
        }
    }
    None
}

/// Probe k6 by running `k6 version`.
pub async fn probe_k6() -> Result<K6Info, String> {
    let path = which_k6().ok_or_else(|| "k6 binary not found".to_string())?;
    let version = read_k6_version(&path).map_err(|e| e.to_string())?;
    Ok(K6Info { version, path })
}

fn read_k6_version(path: &str) -> Result<String, String> {
    let out = std::process::Command::new(path)
        .arg("version")
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    // Strip "k6 " prefix.
    Ok(text.trim_start_matches("k6 ").trim().to_string())
}

/// Parse one summary metric from a k6 summary line.
/// k6 prints rows like:
///   http_req_duration..............: avg=120.45ms min=80ms med=110ms max=300ms p(90)=180ms p(95)=210ms
fn parse_metric(line: &str) -> Option<MetricSummary> {
    // Quick filter: k6 metric rows always have "..." padding after the metric name.
    if !line.contains("...") {
        return None;
    }
    let re = Regex::new(r"^(?P<name>[a-zA-Z0-9_]+)\s*\.+\s*:\s*(?P<body>.+)$").ok()?;
    let caps = re.captures(line.trim())?;
    let name = caps.name("name")?.as_str().to_string();
    let body = caps.name("body")?.as_str();

    let value_re = Regex::new(r"(?P<k>[a-zA-Z0-9_]+)=(?P<v>[0-9eE\.\-\+nanNaN]+)(?P<u>[a-zA-Z%µμ/]*)").ok()?;
    let mut val = String::new();
    let mut unit: Option<String> = None;

    if let Some(cap) = value_re.captures(body) {
        // key=value style (e.g. http_req_duration: avg=120ms ...)
        let first_key = cap.name("k").unwrap().as_str();
        if first_key == "count" {
            val = cap.name("v").unwrap().as_str().to_string();
            unit = cap.name("u").map(|m| m.as_str().to_string()).filter(|s| !s.is_empty());
        } else {
            // Try avg=
            let chosen = value_re
                .captures(body)
                .and_then(|c| c.name("avg").map(|m| m.as_str().to_string()))
                .or_else(|| {
                    value_re
                        .captures(body)
                        .map(|c| c.name("v").unwrap().as_str().to_string())
                });
            if let Some(v) = chosen {
                val = v;
            } else {
                val = cap.name("v").unwrap().as_str().to_string();
            }
            unit = cap.name("u").map(|m| m.as_str().to_string()).filter(|s| !s.is_empty());
        }
    } else {
        // Column-based: name..............: value unit  rate
        // First whitespace-separated token is the value.
        let col_re = Regex::new(r"^\s*(?P<v>\S+)(?:\s+(?P<u>[a-zA-Z%/µμ]+))?").ok()?;
        if let Some(c) = col_re.captures(body) {
            val = c.name("v").unwrap().as_str().to_string();
            unit = c.name("u").map(|m| m.as_str().to_string()).filter(|s| !s.is_empty());
        }
    }

    if val.is_empty() {
        return None;
    }

    Some(MetricSummary {
        name,
        value: format!("{}{}", val, unit.clone().unwrap_or_default()),
        unit,
    })
}

/// Parse all metrics from the full stdout buffer.
pub fn parse_metrics(stdout: &str) -> Vec<MetricSummary> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        if let Some(m) = parse_metric(line) {
            out.push(m);
        }
    }
    // Dedup by name — keep first occurrence.
    let mut seen = std::collections::HashSet::new();
    out.retain(|m| seen.insert(m.name.clone()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_http_req_duration_line() {
        let line = "  http_req_duration..............: avg=120.45ms min min=80ms med=110ms max max=300ms p(90)=180ms p(95)=210ms";
        let m = parse_metric(line).expect("should parse");
        assert_eq!(m.name, "http_req_duration");
        // avg= wins
        assert!(m.value.contains("120") && m.value.contains("ms"), "got {}", m.value);
    }

    #[test]
    fn parses_iterations_count() {
        let line = "    iterations.....................: 1      0.202546/s";
        let m = parse_metric(line).expect("should parse");
        assert_eq!(m.name, "iterations");
        assert_eq!(m.value, "1");
    }

    #[test]
    fn parses_http_reqs_count() {
        let line = "    http_reqs......................: 532    53.2/s";
        let m = parse_metric(line).expect("should parse");
        assert_eq!(m.name, "http_reqs");
        assert_eq!(m.value, "532");
    }

    #[test]
    fn parses_data_received_with_unit() {
        let line = "    data_received..................: 13 kB  2.7 kB/s";
        let m = parse_metric(line).expect("should parse");
        assert_eq!(m.name, "data_received");
        assert_eq!(m.value, "13kB");
    }

    #[test]
    fn parses_http_req_failed_percentage() {
        let line = "    http_req_failed................: 0.00%  0 out of 2";
        let m = parse_metric(line).expect("should parse");
        assert_eq!(m.name, "http_req_failed");
        assert!(m.value.contains("0.00"), "got {}", m.value);
    }

    #[test]
    fn ignores_non_metric_lines() {
        assert!(parse_metric("running (30s), 000/050 VUs, 100 complete and 0 interrupted iterations").is_none());
        assert!(parse_metric("time:        30.0  iterations:  100").is_none());
        assert!(parse_metric("").is_none());
    }

    #[test]
    fn parse_metrics_dedups_by_name() {
        let stdout = "\
http_req_duration...........: avg=120ms min=80ms med=110ms max=300ms
http_req_duration...........: avg=150ms min=85ms med=120ms max=320ms
http_reqs...................: 0    100    10/s
";
        let m = parse_metrics(stdout);
        let names: Vec<_> = m.iter().map(|m| m.name.clone()).collect();
        assert_eq!(names, vec!["http_req_duration", "http_reqs"]);
    }

    #[test]
    fn build_k6_args_passes_cli_args_through() {
        let opts = RunOptions {
            label: None,
            env: HashMap::new(),
            cli_args: vec!["--summary-trend-stats=p(95)".into(), "--quiet".into()],
            max_duration_seconds: 0,
        };
        assert_eq!(
            build_k6_args(&opts),
            vec!["--summary-trend-stats=p(95)".to_string(), "--quiet".to_string()]
        );
    }

    #[test]
    fn build_k6_args_empty_when_no_overrides() {
        let opts = RunOptions {
            label: None,
            env: HashMap::new(),
            cli_args: vec![],
            max_duration_seconds: 0,
        };
        assert!(build_k6_args(&opts).is_empty());
    }

    #[test]
    fn merge_env_is_passthrough_today() {
        let mut env = HashMap::new();
        env.insert("BASE_URL".into(), "https://api.example.com".into());
        env.insert("TOKEN".into(), "abc".into());
        let opts = RunOptions {
            label: None,
            env,
            cli_args: vec![],
            max_duration_seconds: 0,
        };
        let merged = merge_env(&opts);
        assert_eq!(merged.get("BASE_URL").map(String::as_str), Some("https://api.example.com"));
        assert_eq!(merged.get("TOKEN").map(String::as_str), Some("abc"));
        assert_eq!(merged.len(), 2);
    }

    #[test]
    fn merge_env_empty_when_no_overrides() {
        let opts = RunOptions {
            label: None,
            env: HashMap::new(),
            cli_args: vec![],
            max_duration_seconds: 0,
        };
        assert!(merge_env(&opts).is_empty());
    }
}