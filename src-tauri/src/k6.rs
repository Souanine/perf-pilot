use crate::fs;
use chrono::{DateTime, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::process::Stdio;
use tauri::{Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
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

    /// Spawn the actual run. This function returns once k6 has been launched;
    /// output continues to be streamed on background tasks and is also written
    /// to a JSON file under the app's runs directory.
    pub async fn spawn(
        runners: std::sync::Arc<AsyncMutex<Vec<K6Runner>>>,
        idx: usize,
        window: tauri::Window,
    ) -> Result<(), String> {
        let app_handle = window.app_handle().clone();
        let (cancel_tx, cancel_rx) = oneshot::channel();

        // Snapshot the runner state from the shared vector. The caller must NOT
        // hold the runners lock across this call — we re-acquire it here using
        // the async API since this function runs inside a tokio runtime.
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

        // Attach the cancel sender to the runner in a fresh critical section.
        {
            let mut guard = runners.lock().await;
            if let Some(r) = guard.get_mut(target_idx) {
                r.cancel = Some(cancel_tx);
            }
        }

        let label = options.label.clone();

        let k6_path = which_k6().unwrap_or_else(|| "k6".to_string());
        let k6_version = read_k6_version(&k6_path).unwrap_or_else(|_| "unknown".to_string());

        let mut args: Vec<String> = vec!["run".to_string()];
        args.extend(options.cli_args.iter().cloned());
        args.push(script_path.clone());

        let mut command_vec: Vec<String> = vec![k6_path.clone()];
        command_vec.extend(args.clone());

        let _ = window.emit(
            "k6://event",
            RunEvent::Started {
                run_id: run_id.clone(),
                started_at,
                k6_version,
                command: command_vec,
            },
        );

        let runners_ref = runners.clone();
        let window_clone = window.clone();
        let app_handle_clone = app_handle.clone();
        let run_id_for_task = run_id.clone();
        let label_for_task = label.clone();
        let script_path_for_task = script_path.clone();

        tauri::async_runtime::spawn(async move {
            let mut cmd = Command::new(&k6_path);
            cmd.args(&args)
                .envs(&options.env)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            if options.max_duration_seconds > 0 {
                cmd.kill_on_drop(true);
            }

            // Pass through additional env vars.
            for (k, v) in &options.env {
                cmd.env(k, v);
            }

            let mut child = match cmd.spawn() {
                Ok(c) => c,
                Err(e) => {
                    let err = format!("Failed to spawn k6: {}", e);
                    let _ = window_clone.emit(
                        "k6://event",
                        RunEvent::Finished {
                            run_id: run_id_for_task.clone(),
                            finished_at: Utc::now(),
                            exit_code: None,
                            status: "errored".to_string(),
                            error: Some(err.clone()),
                        },
                    );
                    finalize_run(
                        &app_handle_clone,
                        &runners_ref,
                        &run_id_for_task,
                        RunFinalize {
                            status: "errored".into(),
                            exit_code: None,
                            error: Some(err),
                            stderr: String::new(),
                            stdout: String::new(),
                            label: label_for_task.clone(),
                            script_path: script_path_for_task.clone(),
                            started_at,
                        },
                    )
                    .await;
                    return;
                }
            };

            // Record PID so we can attempt termination on stop.
            if let Some(pid) = child.id() {
                let mut guard = match runners_ref.try_lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                if let Some(r) = guard.iter_mut().find(|r| r.run_id == run_id_for_task) {
                    r.child_pid = Some(pid);
                }
            }

            let stdout = child.stdout.take();
            let stderr = child.stderr.take();

            // Shared accumulators.
            let stdout_buf = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
            let stderr_buf = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
            let metrics_acc = std::sync::Arc::new(std::sync::Mutex::new(Vec::<MetricSummary>::new()));

            // Stream stdout
            let stdout_task = if let Some(stdout) = stdout {
                let win = window_clone.clone();
                let buf = stdout_buf.clone();
                let metrics = metrics_acc.clone();
                let run_id_inner = run_id_for_task.clone();
                Some(tauri::async_runtime::spawn(async move {
                    let mut reader = BufReader::new(stdout).lines();
                    while let Ok(Some(line)) = reader.next_line().await {
                        {
                            let mut g = buf.lock().unwrap();
                            g.push_str(&line);
                            g.push('\n');
                        }
                        // Try to parse a summary metric from this line.
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

            let stderr_task = if let Some(stderr) = stderr {
                let win = window_clone.clone();
                let buf = stderr_buf.clone();
                let run_id_inner = run_id_for_task.clone();
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

            // Cancellation watcher: when cancel fires, kill the child.
            let cancel_child_id = child.id();
            let cancel_task = tauri::async_runtime::spawn(async move {
                let _ = cancel_rx.await;
                if let Some(pid) = cancel_child_id {
                    // best-effort terminate
                    let _ = std::process::Command::new("kill")
                        .arg("-TERM")
                        .arg(pid.to_string())
                        .output();
                }
            });
            // Hold cancel_task so it isn't dropped until the function returns;
            // we don't await it (would deadlock) — it self-completes when
            // cancel_tx is dropped in finalize_run.
            let _cancel_task = cancel_task;

            let status = child.wait().await;
            // Drop our reference to the runners vector's runner so cancel_tx
            // is released (if not already). We can't await cancel_task — that
            // would deadlock because cancel_rx only resolves when the sender
            // (still held by the runner) is dropped or used. The cancel_task
            // continues independently and is cleaned up when its scope ends.

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

            let _ = window_clone.emit(
                "k6://event",
                RunEvent::Finished {
                    run_id: run_id_for_task.clone(),
                    finished_at: Utc::now(),
                    exit_code,
                    status: status_str.clone(),
                    error: error.clone(),
                },
            );

            let stdout_text = stdout_buf.lock().unwrap().clone();
            let stderr_text = stderr_buf.lock().unwrap().clone();

            finalize_run(
                &app_handle_clone,
                &runners_ref,
                &run_id_for_task,
                RunFinalize {
                    status: status_str,
                    exit_code,
                    error,
                    stderr: stderr_text,
                    stdout: stdout_text,
                    label: label_for_task.clone(),
                    script_path: script_path_for_task.clone(),
                    started_at,
                },
            )
            .await;
        });

        Ok(())
    }
}

struct RunFinalize {
    status: String,
    exit_code: Option<i32>,
    error: Option<String>,
    stderr: String,
    stdout: String,
    label: Option<String>,
    script_path: String,
    started_at: DateTime<Utc>,
}

async fn finalize_run(
    app_handle: &tauri::AppHandle,
    runners: &std::sync::Arc<AsyncMutex<Vec<K6Runner>>>,
    run_id: &str,
    fin: RunFinalize,
) {
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
        script_path: fin.script_path.clone(),
        label: fin.label.clone(),
        started_at: fin.started_at,
        finished_at: Some(Utc::now()),
        exit_code: fin.exit_code,
        status: fin.status.clone(),
        stdout: fin.stdout.clone(),
        stderr: fin.stderr.clone(),
        metrics: parse_metrics(&fin.stdout),
        error: fin.error.clone(),
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
}