use crate::fs;
use chrono::{DateTime, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex as StdMutex};
use tauri::{Emitter, Manager};
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
    /// Credential ids whose secret values get injected into the k6 process
    /// env at spawn time. Ids only — values never cross the IPC bridge.
    #[serde(default)]
    pub credentials: Vec<String>,
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
    /// Metrics already collected by the streaming phase. `conclude_run`
    /// no longer needs to re-scan stdout — these are the same `Metric`
    /// events that were streamed live to the UI.
    pub(crate) metrics: Vec<MetricSummary>,
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
        let (run_id, script_path, options, started_at, target_idx) = {
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

        let args = build_k6_args(&script_path, &options);
        let mut env = merge_env(&options);
        // Resolve credential secret values in-process so they never travel
        // through IPC or argv. A missing or empty pool aborts the run before
        // k6 starts — running without auth would only produce misleading
        // results (a wall of 401s reported as "passed").
        match crate::credentials::resolve_for_run(window.app_handle(), &options.credentials) {
            Ok(cred_env) => env.extend(cred_env),
            Err(e) => {
                let err = format!("Credential injection failed: {e}");
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
        }
        // Surface the command we are actually going to exec, not a
        // partial reconstruction of it.
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

        // Race the cancel signal against the child's natural exit. Whoever
        // fires first wins:
        //   * cancel → kill the child best-effort, then await its exit.
        //   * natural exit → cancel_rx is dropped here and the task that
        //     held it can finally resolve, so no JoinHandle is leaked.
        let cancel_child_id = child.id();
        let status = tokio::select! {
            _ = cancel_rx => {
                if let Some(pid) = cancel_child_id {
                    let _ = std::process::Command::new("kill")
                        .arg("-TERM")
                        .arg(pid.to_string())
                        .output();
                }
                child.wait().await
            }
            s = child.wait() => s,
        };
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
        // `metrics_acc` was populated by the streaming stdout task. We
        // dedup by name (same rule the old `parse_metrics` followed) so
        // k6's tendency to emit both a summary block and a final
        // end-of-run block doesn't double-count.
        let mut metrics = metrics_acc.lock().unwrap().clone();
        let mut seen = std::collections::HashSet::new();
        metrics.retain(|m| seen.insert(m.name.clone()));

        RunConclude {
            status: status_str,
            exit_code,
            error,
            stdout: stdout_text,
            stderr: stderr_text,
            metrics,
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
            metrics: conclusion.metrics,
            error: conclusion.error,
        };
        if let Ok(json) = serde_json::to_string_pretty(&output) {
            let _ = std::fs::write(&out_path, json);
        }

        // Mirror the run's metadata into the sidecar index so
        // `list_runs` doesn't have to scan + parse every per-run JSON.
        let (p95_ms, rps, error_rate_pct) =
            crate::fs::extract_chart_metrics(&output.stdout);
        let index_record = crate::fs::RunRecord {
            run_id: run_id.to_string(),
            label: output.label.clone(),
            status: output.status.clone(),
            started_at: output.started_at,
            finished_at: output.finished_at,
            exit_code: output.exit_code,
            script_path: output.script_path.clone(),
            p95_ms,
            rps,
            error_rate_pct,
        };
        let _ = crate::fs::upsert_run_index(app_handle, &index_record).await;

        // Drop the runner from the in-memory list.
        let mut guard = match runners.try_lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        guard.retain(|r| r.run_id != run_id);
    }
}

// --- Pure-function helpers (unit-testable, no I/O) --------------------

/// Build the full k6 CLI argument vector for `k6 run`.
///
/// Shape: `run <cli_args...> <script>` — flags precede the script, which
/// is the form k6 documents. The `run` subcommand and the script path
/// are load-bearing: omitting them makes k6 print usage and exit, which
/// is exactly the "the script won't run" symptom this guards against.
fn build_k6_args(script_path: &str, options: &RunOptions) -> Vec<String> {
    let mut args = vec!["run".to_string()];
    args.extend(options.cli_args.iter().cloned());
    args.push(script_path.to_string());
    args
}

/// Merge env vars from `RunOptions`. Today this is a passthrough; the seam
/// exists so future defaults (e.g. `K6_NO_COLOR=1`) can land here without
/// changing the call site.
fn merge_env(options: &RunOptions) -> HashMap<String, String> {
    options.env.clone()
}

/// Detect the k6 binary.
///
/// Resolution order:
///   1. `K6_PATH` — explicit user override (e.g. for a custom-built k6)
///   2. `PERFPILOT_K6_BIN` — bundled sidecar, set by `lib::run` at startup
///   3. Common system locations (Homebrew, system paths)
///   4. `command -v k6` against `$PATH`
pub fn which_k6() -> Option<String> {
    if let Ok(p) = std::env::var("K6_PATH") {
        if std::path::Path::new(&p).exists() {
            return Some(p);
        }
    }
    if let Ok(p) = std::env::var("PERFPILOT_K6_BIN") {
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

/// Resolve the bundled k6 sidecar's expected on-disk path.
///
/// Tauri 2's `bundle.externalBin` ships the binary alongside the host
/// executable (macOS: `Contents/MacOS/`, Windows/Linux: next to the .exe).
///
/// **Filename note**: the *source* file in `src-tauri/binaries/` must be
/// named `k6-<target-triple>[.exe]` for Tauri's bundler to find it during
/// build, but the bundler **strips** the triple suffix when placing the
/// binary in the output bundle. The on-disk name in a packaged app is just
/// `k6.exe` (Windows) or `k6` (macOS/Linux). Looking for the triple-suffixed
/// name at runtime fails silently — the original bug was that
/// `which_k6()` would never see the bundled binary and fall through to PATH,
/// which "happened to work" on macOS where most users have Homebrew k6 but
/// silently broke on Windows.
///
/// In dev (`tauri dev`) the binary is placed next to the dev executable
/// with the same stripped name; in release builds it's inside the bundled
/// `.app` / `.exe`. Both share the same directory as `current_exe()`.
pub fn resolve_sidecar_k6_path() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    // `cfg!(windows)` is host-platform at compile time — the dev binary
    // and the bundled binary both go by the same name on the same host.
    let bin_name = if cfg!(windows) { "k6.exe" } else { "k6" };
    let p = dir.join(bin_name);
    if p.exists() { Some(p) } else { None }
}

/// `rustc -vV` host triple, e.g. `aarch64-apple-darwin`.
///
/// Test-only: the sidecar is resolved at runtime from the bundled name,
/// so only the sidecar-location tests need the compile-time triple.
#[cfg(test)]
fn current_target_triple() -> &'static str {
    // Computed at compile time by `build.rs` from Cargo's `TARGET` env var.
    // This is the same string Tauri uses to suffix the sidecar filename.
    option_env!("PERFPILOT_TARGET_TRIPLE").unwrap_or("")
}

/// Marker that the sidecar env var is set. Kept separate from `which_k6`
/// so the integration in `lib.rs` is a single call.
pub fn publish_sidecar_path_to_env() {
    if let Some(p) = resolve_sidecar_k6_path() {
        std::env::set_var("PERFPILOT_K6_BIN", &p);
    }
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

/// Static regexes for the summary parser. Compiling a `Regex` walks the
/// pattern string every call; a 30s soak pushing 5k summary-adjacent lines
/// through `parse_metric` would otherwise compile the same patterns
/// thousands of times. `LazyLock` initialises them once on first use.
static METRIC_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?P<name>[a-zA-Z0-9_]+)\s*\.+\s*:\s*(?P<body>.+)$").unwrap()
});
static VALUE_KV: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?P<k>[a-zA-Z0-9_]+)=(?P<v>[0-9eE\.\-\+nanNaN]+)(?P<u>[a-zA-Z%µμ/]*)")
        .unwrap()
});
static VALUE_COL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*(?P<v>\S+)(?:\s+(?P<u>[a-zA-Z%/µμ]+))?").unwrap()
});

fn parse_metric(line: &str) -> Option<MetricSummary> {
    // Quick filter: k6 metric rows always have "..." padding after the metric name.
    if !line.contains("...") {
        return None;
    }
    let caps = METRIC_LINE.captures(line.trim())?;
    let name = caps.name("name")?.as_str().to_string();
    let body = caps.name("body")?.as_str();

    let mut val = String::new();
    let mut unit: Option<String> = None;

    if let Some(cap) = VALUE_KV.captures(body) {
        // key=value style (e.g. http_req_duration: avg=120ms ...)
        let first_key = cap.name("k").unwrap().as_str();
        if first_key == "count" {
            val = cap.name("v").unwrap().as_str().to_string();
            unit = cap.name("u").map(|m| m.as_str().to_string()).filter(|s| !s.is_empty());
        } else {
            // No "avg" group exists; pick `avg=…` first by scanning the
            // value column once. Falls back to the first matched number.
            val = pick_preferred_value(body).unwrap_or_else(|| cap.name("v").unwrap().as_str().to_string());
            unit = cap.name("u").map(|m| m.as_str().to_string()).filter(|s| !s.is_empty());
        }
    } else if let Some(c) = VALUE_COL.captures(body) {
        // Column-based: name..............: value unit  rate
        // First whitespace-separated token is the value.
        val = c.name("v").unwrap().as_str().to_string();
        unit = c.name("u").map(|m| m.as_str().to_string()).filter(|s| !s.is_empty());
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

/// Walk the body left-to-right, returning the value of the first `avg=…`
/// token; otherwise the value of the very first `key=value` token. The
/// original regex had a dead `name("avg")` lookup (no such group exists)
/// which always fell through to the `v` branch — fixing the obvious bug
/// while keeping the same observable output for the test fixture.
fn pick_preferred_value(body: &str) -> Option<String> {
    let mut first: Option<String> = None;
    for cap in VALUE_KV.captures_iter(body) {
        let k = cap.name("k").unwrap().as_str();
        let v = cap.name("v").unwrap().as_str().to_string();
        if first.is_none() {
            first = Some(v.clone());
        }
        if k == "avg" {
            return Some(v);
        }
    }
    first
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
    fn build_k6_args_includes_run_subcommand_and_script() {
        // Regression guard: the vector used to be just `cli_args`, so the
        // spawned process was `k6 --quiet` with no subcommand and no
        // script — k6 prints usage and exits, and the UI reported a run
        // that could never do anything. `run` and the script path are
        // load-bearing, not decoration.
        let opts = RunOptions {
            label: None,
            env: HashMap::new(),
            cli_args: vec!["--summary-trend-stats=p(95)".into(), "--quiet".into()],
            max_duration_seconds: 0,
            credentials: vec![],
        };
        assert_eq!(
            build_k6_args("/app/scripts/smoke.js", &opts),
            vec![
                "run".to_string(),
                "--summary-trend-stats=p(95)".to_string(),
                "--quiet".to_string(),
                "/app/scripts/smoke.js".to_string(),
            ]
        );
    }

    #[test]
    fn build_k6_args_still_runs_with_no_cli_overrides() {
        let opts = RunOptions {
            label: None,
            env: HashMap::new(),
            cli_args: vec![],
            max_duration_seconds: 0,
            credentials: vec![],
        };
        assert_eq!(
            build_k6_args("/app/scripts/smoke.js", &opts),
            vec!["run".to_string(), "/app/scripts/smoke.js".to_string()]
        );
    }

    /// The arguments must form a command k6 actually accepts. Shelling
    /// out to `k6 run --help`-free validation isn't possible without
    /// invoking the binary, so this asserts the structural invariant:
    /// `run` is first and the script is last.
    #[test]
    fn build_k6_args_shape_is_run_then_flags_then_script() {
        let opts = RunOptions {
            label: None,
            env: HashMap::new(),
            cli_args: vec!["--vus".into(), "2".into()],
            max_duration_seconds: 0,
            credentials: vec![],
        };
        let args = build_k6_args("/s.js", &opts);
        assert_eq!(args.first().map(String::as_str), Some("run"));
        assert_eq!(args.last().map(String::as_str), Some("/s.js"));
        assert!(!args.iter().any(|a| a.is_empty()));
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
            credentials: vec![],
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
            credentials: vec![],
        };
        assert!(merge_env(&opts).is_empty());
    }

    /// Older payloads (and the e2e mock) omit `credentials` entirely;
    /// `serde(default)` must keep them deserializing.
    #[test]
    fn run_options_deserialize_without_credentials_field() {
        let opts: RunOptions =
            serde_json::from_str(r#"{"label":"x","env":{},"cli_args":[]}"#).unwrap();
        assert!(opts.credentials.is_empty());
    }

    #[test]
    fn run_options_carry_credential_ids() {
        let opts: RunOptions =
            serde_json::from_str(r#"{"credentials":["cred-1","cred-2"]}"#).unwrap();
        assert_eq!(opts.credentials, vec!["cred-1".to_string(), "cred-2".to_string()]);
    }

    /// `resolve_sidecar_k6_path` should look next to `current_exe()` for
    /// `k6.exe` (Windows) or `k6` (Unix) — Tauri's bundler strips the
    /// target-triple suffix at bundle time. If a sidecar happens to be
    /// sitting next to the test runner, confirm we look up the right name.
    #[test]
    fn sidecar_path_uses_bundled_name_not_triple_suffix() {
        let expected_name = if cfg!(windows) { "k6.exe" } else { "k6" };
        if let Some(p) = resolve_sidecar_k6_path() {
            let name = p.file_name().unwrap().to_string_lossy().to_string();
            assert_eq!(name, expected_name);
        }
        // Otherwise None is fine — common during `cargo test`.
    }

    /// End-to-end: drop a `k6` binary next to the test runner (the same
    /// directory layout Tauri uses in a packaged app) and confirm
    /// `resolve_sidecar_k6_path` finds it. This is the runtime path
    /// that previously missed because the lookup used `k6-<triple>`
    /// instead of the bundled `k6`.
    #[test]
    fn resolve_sidecar_k6_path_finds_bundled_binary_next_to_exe() {
        let exe = std::env::current_exe().expect("current_exe");
        let dir = exe.parent().expect("exe parent");
        let bin_name = if cfg!(windows) { "k6.exe" } else { "k6" };
        let staged = dir.join(format!(".perf-pilot-test-k6-{bin_name}"));

        // Locate the real sidecar source and place a copy / hardlink next
        // to the test runner under the expected bundled name.
        let triple = current_target_triple();
        assert!(!triple.is_empty(), "PERFPILOT_TARGET_TRIPLE must be set by build.rs");
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("k6-{triple}"));
        if !src.exists() {
            eprintln!(
                "skip: sidecar source missing at {} — run scripts/fetch-k6.sh",
                src.display()
            );
            return;
        }
        std::fs::copy(&src, &staged).expect("copy sidecar to staging path");

        // Move the staged copy to the exact bundled name next to the test
        // runner, then call the resolver.
        let target = dir.join(bin_name);
        if target.exists() {
            // Don't trample a real `k6` — back it up briefly.
            let backup = dir.join(format!(".perf-pilot-test-k6-backup-{bin_name}"));
            std::fs::rename(&target, &backup).expect("backup existing k6");
            std::fs::rename(&staged, &target).expect("stage sidecar at bundled name");
            let resolved = resolve_sidecar_k6_path();
            std::fs::rename(&target, &staged).expect("restore staged");
            std::fs::rename(&backup, &target).expect("restore original k6");
            assert!(resolved.is_some(), "resolver should find staged sidecar");
            assert_eq!(resolved.unwrap(), target);
        } else {
            std::fs::rename(&staged, &target).expect("stage sidecar at bundled name");
            let resolved = resolve_sidecar_k6_path();
            std::fs::remove_file(&target).expect("cleanup staged sidecar");
            assert!(resolved.is_some(), "resolver should find staged sidecar");
            assert_eq!(resolved.unwrap(), target);
        }
        let _ = std::fs::remove_file(&staged); // may already be moved
    }

    /// End-to-end: when the system has no k6 (PATH is empty, K6_PATH is
    /// unset), setting `PERFPILOT_K6_BIN` to the bundled sidecar must be
    /// enough for `which_k6` to find it. This is the exact mechanism
    /// `publish_sidecar_path_to_env` uses at app startup.
    #[test]
    fn which_k6_falls_through_to_sidecar_when_path_is_clean() {
        // Locate the sidecar via the source tree (works regardless of
        // where `cargo test` happens to put the test runner).
        let triple = current_target_triple();
        let src_sidecar = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("k6-{triple}"));
        assert!(
            src_sidecar.exists(),
            "expected sidecar at {} (run scripts/fetch-k6.sh)",
            src_sidecar.display()
        );

        // Clear every resolution source we know about, then expose the
        // sidecar through the env var mechanism the runtime uses.
        let prev_k6_path = std::env::var("K6_PATH").ok();
        let prev_sidecar = std::env::var("PERFPILOT_K6_BIN").ok();
        std::env::remove_var("K6_PATH");
        std::env::set_var("PERFPILOT_K6_BIN", &src_sidecar);

        let resolved = which_k6().expect("which_k6 should find the sidecar");
        assert_eq!(resolved, src_sidecar.to_string_lossy().to_string());

        // Restore env so parallel tests aren't polluted.
        if let Some(v) = prev_k6_path {
            std::env::set_var("K6_PATH", v);
        }
        match prev_sidecar {
            Some(v) => std::env::set_var("PERFPILOT_K6_BIN", v),
            None => std::env::remove_var("PERFPILOT_K6_BIN"),
        }
    }

    // --- Tests that spawn the real k6 binary ---------------------------
    //
    // Everything above is pure-function level: `build_k6_args` returns a
    // `Vec<String>`, `parse_metrics` takes a `&str`. A whole class of
    // defect therefore passes every unit test while breaking the app --
    // most memorably `prepare_run` spawning `k6 <cli_args>` with no `run`
    // subcommand and no script path, so every run exited with
    // `unknown flag`. The e2e suite cannot catch it either: it stubs
    // Tauri IPC, so `run_k6` returns canned data and k6 never launches.
    //
    // These construct the command exactly the way `prepare_run` does and
    // assert k6 actually accepts it. Verified by reverting
    // `build_k6_args`: 7 tests fail, 4 of them these. Deliberately
    // network-free so the suite stays deterministic and works offline;
    // each test skips rather than fails when no k6 is present.

    /// `which_k6` first, then the bundled sidecar.
    ///
    /// `publish_sidecar_path_to_env` only runs under the Tauri app, and
    /// `resolve_sidecar_k6_path` looks next to the *test* binary
    /// (`target/debug/deps/`) whereas `tauri dev` stages the sidecar one
    /// level up in `target/debug/`. Neither is the source of truth, so
    /// fall back to the tree in `binaries/`.
    fn spawnable_k6() -> Option<String> {
        which_k6()
            .or_else(|| resolve_sidecar_k6_path().map(|p| p.to_string_lossy().to_string()))
            .or_else(source_sidecar)
    }

    /// `src-tauri/binaries/k6-<triple>` — where `scripts/fetch-k6.sh`
    /// drops it. This is the path CI uses, so it is what makes these
    /// tests meaningful on a fresh checkout.
    fn source_sidecar() -> Option<String> {
        let triple = current_target_triple();
        if triple.is_empty() {
            return None;
        }
        let name = if cfg!(windows) {
            format!("k6-{triple}.exe")
        } else {
            format!("k6-{triple}")
        };
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(name);
        p.exists().then(|| p.to_string_lossy().to_string())
    }

    fn k6_or_skip(test_name: &str) -> Option<String> {
        match spawnable_k6() {
            Some(p) => Some(p),
            None => {
                eprintln!("skip: {test_name} - no k6 binary (run scripts/fetch-k6.sh)");
                None
            }
        }
    }

    /// A k6 script that performs no I/O. `iterations` keeps it
    /// deterministic; `sleep` gives the loop something to do without
    /// touching the network.
    const NO_NETWORK_SCRIPT: &str = "\
import { sleep } from 'k6';
export const options = { vus: 1, iterations: 2 };
export default function () {
  sleep(0.01);
}
";

    fn write_fixture(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("perf-pilot-it");
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join(format!("{name}.js"));
        std::fs::write(&path, NO_NETWORK_SCRIPT).expect("write fixture");
        path
    }

    /// Mirrors `prepare_run`: `Command::new(k6).args(build_k6_args(..))`.
    /// Keeping the construction identical is the whole point -- a test
    /// that built the argv differently would pass while the app stayed
    /// broken.
    fn run_k6_like_the_app(
        k6: &str,
        script_path: &str,
        options: &RunOptions,
    ) -> std::process::Output {
        let args = build_k6_args(script_path, options);
        std::process::Command::new(k6).args(&args).output().expect("spawn k6")
    }

    fn plain_opts() -> RunOptions {
        RunOptions {
            label: None,
            env: HashMap::new(),
            cli_args: vec![],
            max_duration_seconds: 0,
            credentials: vec![],
        }
    }

    #[test]
    fn real_k6_reports_a_version() {
        let Some(k6) = k6_or_skip("real_k6_reports_a_version") else { return };
        let v = read_k6_version(&k6).expect("read k6 version");
        assert!(
            v.to_lowercase().contains("k6"),
            "expected a k6 version string, got {v:?}"
        );
    }

    #[test]
    fn real_k6_runs_a_script_and_exits_zero() {
        let Some(k6) = k6_or_skip("real_k6_runs_a_script_and_exits_zero") else { return };
        let script = write_fixture("smoke");

        let out = run_k6_like_the_app(&k6, &script.to_string_lossy(), &plain_opts());
        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(
            out.status.success(),
            "k6 exited {:?}\n--- stdout ---\n{stdout}\n--- stderr ---\n{stderr}",
            out.status.code()
        );

        // Exit code alone is NOT proof: bare `k6` prints the banner and
        // exits 0 without running anything. That is exactly how the
        // missing-subcommand regression would slip past a status check,
        // so assert the run actually happened.
        let parsed = parse_metrics(&stdout);
        let names: Vec<&str> = parsed.iter().map(|m| m.name.as_str()).collect();
        assert!(
            names.contains(&"iterations"),
            "k6 exited 0 but never ran the script (no `iterations` metric).\n\
             This is what bare `k6` looks like.\n--- stdout ---\n{stdout}"
        );
        let _ = std::fs::remove_file(&script);
    }

    /// Regression guard for the missing `run` subcommand: the argv
    /// `prepare_run` used to exec produced exactly this failure.
    #[test]
    fn k6_rejects_argv_without_the_run_subcommand() {
        let Some(k6) = k6_or_skip("k6_rejects_argv_without_the_run_subcommand") else { return };

        let bare = std::process::Command::new(&k6)
            .args(["--summary-trend-stats=p(95)", "--quiet"])
            .output()
            .expect("spawn k6");
        assert!(
            !bare.status.success(),
            "k6 accepted a bare flag list; if this ever passes, the regression \
             it guards may no longer reproduce and the guard is worthless"
        );
    }

    #[test]
    fn cli_args_are_forwarded_and_the_script_still_runs() {
        let Some(k6) = k6_or_skip("cli_args_are_forwarded_and_the_script_still_runs") else { return };
        let script = write_fixture("with-flags");

        let opts = RunOptions {
            cli_args: vec!["--quiet".into(), "--no-usage-report".into()],
            ..plain_opts()
        };
        let out = run_k6_like_the_app(&k6, &script.to_string_lossy(), &opts);
        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(
            out.status.success(),
            "k6 rejected forwarded flags: {:?}\n--- stderr ---\n{stderr}",
            out.status.code()
        );
        // `--quiet` drops the banner but keeps the summary block, which is
        // what `parse_metrics` consumes.
        assert!(!stdout.trim().is_empty(), "expected summary output, got nothing");
        let _ = std::fs::remove_file(&script);
    }

    #[test]
    fn real_k6_summary_parses_into_metrics() {
        let Some(k6) = k6_or_skip("real_k6_summary_parses_into_metrics") else { return };
        let script = write_fixture("metrics");

        let out = run_k6_like_the_app(&k6, &script.to_string_lossy(), &plain_opts());
        assert!(out.status.success(), "k6 run failed");
        let stdout = String::from_utf8_lossy(&out.stdout);

        let metrics = parse_metrics(&stdout);
        assert!(
            !metrics.is_empty(),
            "no metrics parsed from real k6 output:\n{stdout}"
        );
        let names: Vec<&str> = metrics.iter().map(|m| m.name.as_str()).collect();
        assert!(
            names.contains(&"iterations"),
            "expected an `iterations` metric, got {names:?}"
        );
        let _ = std::fs::remove_file(&script);
    }

    #[test]
    fn a_missing_script_fails_instead_of_hanging() {
        let Some(k6) = k6_or_skip("a_missing_script_fails_instead_of_hanging") else { return };
        let missing = std::env::temp_dir().join("perf-pilot-it/definitely-absent.js");
        let out = run_k6_like_the_app(&k6, &missing.to_string_lossy(), &plain_opts());
        assert!(
            !out.status.success(),
            "k6 should fail on a missing script but exited 0"
        );
    }
}
