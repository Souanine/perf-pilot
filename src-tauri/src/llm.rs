use crate::k6::RunOutput;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// A provider configuration as supplied by the user from the LLM Settings page.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct LlmProviderConfig {
    /// "openai" | "anthropic" | "ollama" | "custom"
    pub provider: String,
    /// Base URL — e.g. https://api.openai.com/v1
    pub base_url: String,
    /// API key (may be empty for Ollama).
    #[serde(default)]
    pub api_key: String,
    /// Model name.
    pub model: String,
    /// Optional organization / tenant id (for OpenAI).
    #[serde(default)]
    pub organization: Option<String>,
    /// Sampling temperature.
    #[serde(default = "default_temperature")]
    pub temperature: f32,
}

fn default_temperature() -> f32 {
    0.2
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "role", rename_all = "lowercase")]
pub enum ChatMessage {
    System { content: String },
    User { content: String },
    Assistant { content: String },
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScriptGenRequest {
    /// The natural-language description of the test scenario.
    pub prompt: String,
    /// Optional style hints — duration, VUs, endpoints, etc.
    #[serde(default)]
    pub hint: Option<String>,
    /// Target base URL the script should call.
    #[serde(default)]
    pub base_url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScriptGenResponse {
    pub script: String,
    pub explanation: Option<String>,
    pub model: String,
    pub tokens_in: Option<u32>,
    pub tokens_out: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LlmTestResult {
    pub ok: bool,
    pub message: String,
    pub model: Option<String>,
}

/// User request to generate a markdown performance report from a completed run.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ReportGenRequest {
    /// The k6 run whose results should be analyzed.
    pub run_id: String,
    /// BCP-47-ish locale code ("en", "zh-CN") — the report should be written
    /// in this language when possible.
    #[serde(default)]
    pub locale: Option<String>,
}

/// Response from the LLM after generating a report.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ReportGenResponse {
    /// The final, cleaned markdown report body.
    pub report: String,
    pub model: String,
    pub tokens_in: Option<u32>,
    pub tokens_out: Option<u32>,
}

/// Top-level: generate a k6 script from a natural-language description.
pub async fn generate_script(
    provider: &LlmProviderConfig,
    request: &ScriptGenRequest,
    history: Vec<ChatMessage>,
) -> anyhow::Result<ScriptGenResponse> {
    let mut messages = vec![ChatMessage::System {
        content: system_prompt().to_string(),
    }];

    // Optional user hint merged into the prompt.
    let mut composed = request.prompt.clone();
    if let Some(hint) = &request.hint {
        if !hint.trim().is_empty() {
            composed.push_str("\n\nHints:\n");
            composed.push_str(hint);
        }
    }
    if let Some(url) = &request.base_url {
        if !url.trim().is_empty() {
            composed.push_str(&format!("\n\nTarget base URL: {}", url));
        }
    }

    messages.push(ChatMessage::User {
        content: composed,
    });
    for m in history {
        messages.push(m);
    }

    let (text, model, tin, tout) = dispatch_chat(provider, &messages).await?;

    let (script, explanation) = extract_script_and_explanation(&text);

    Ok(ScriptGenResponse {
        script,
        explanation,
        model,
        tokens_in: tin,
        tokens_out: tout,
    })
}

/// Verify connectivity to the LLM provider.
pub async fn test_provider(provider: &LlmProviderConfig) -> anyhow::Result<LlmTestResult> {
    let messages = vec![
        ChatMessage::System {
            content: "You are a connectivity probe. Reply with the single word: OK".to_string(),
        },
        ChatMessage::User {
            content: "ping".to_string(),
        },
    ];
    match dispatch_chat(provider, &messages).await {
        Ok((text, model, _, _)) => Ok(LlmTestResult {
            ok: !text.trim().is_empty(),
            message: format!("Connected — model replied ({}).", model),
            model: Some(model),
        }),
        Err(e) => Ok(LlmTestResult {
            ok: false,
            message: format!("Connection failed: {}", e),
            model: None,
        }),
    }
}

/// Top-level: generate a markdown performance report from a completed run.
///
/// The LLM is given a structured prompt with the run's metadata, summary
/// metrics, and the tail of stdout/stderr. It must respond with a single
/// fenced ```markdown``` block that we extract and sanitize.
pub async fn generate_report(
    provider: &LlmProviderConfig,
    run: &RunOutput,
    locale: &str,
) -> anyhow::Result<ReportGenResponse> {
    let prompt = build_report_user_prompt(run);
    let system = build_report_system_prompt(locale);

    let messages = vec![
        ChatMessage::System { content: system },
        ChatMessage::User { content: prompt },
    ];

    let (text, model, tin, tout) = dispatch_chat(provider, &messages).await?;
    let report = extract_markdown(&text);

    Ok(ReportGenResponse {
        report,
        model,
        tokens_in: tin,
        tokens_out: tout,
    })
}

/// System prompt for the report-generation LLM call.
fn build_report_system_prompt(locale: &str) -> String {
    let language_directive = match locale {
        "zh" | "zh-CN" | "zh-Hans" | "zh-Hans-CN" => {
            " Write the entire report in 简体中文 (Simplified Chinese)."
        }
        _ => " Write the entire report in English.",
    };

    format!(
        r#"You are PerfPilot Reporter, an expert k6 / load-testing analyst. \
You receive the structured output of a completed k6 run and produce a concise, \
actionable Markdown performance report for engineers.{language_directive}

Rules:
1. Output MUST be a single, complete Markdown document wrapped in a ```markdown \
fenced code block. Nothing else — no preamble, no postscript.
2. Use these top-level sections in order (omit a section only if the data is \
missing):
   - `# Performance Report` — title with the run label / script filename.
   - `## Executive Summary` — 3-5 sentences: pass/fail verdict, headline \
metrics, biggest risk. Plain language, no buzzwords.
   - `## Key Metrics` — a Markdown table with at least: HTTP request count, \
average duration, p(95) duration, p(99) duration (if present), error rate, \
throughput (req/s), data received, iteration count.
   - `## Bottlenecks & Risks` — bullet list calling out concrete issues \
(high p95/p99, threshold breach, error rate, slow endpoint). Quote the metric \
value that backs each claim.
   - `## Recommendations` — numbered list of concrete next steps. Each step \
should be small enough to act on in one PR.
   - `## Threshold Verdict` — one-line PASS/FAIL per threshold observed in the \
raw output, with the threshold text quoted.
3. Numbers must come from the input. Do not invent metrics. If a value is \
missing, write `n/a` instead of guessing.
4. Keep the report under 600 words. Be specific, not generic. \
Cite metric values inline (e.g. "p(95) = 412ms" vs "high latency")."#
    )
}

/// Construct the user-side prompt: a compact summary of the run the LLM
/// has to analyze. We send the raw k6 summary tail (the lines after
/// `scenarios'`) so the model can quote thresholds and group metrics without
/// us having to re-parse them.
fn build_report_user_prompt(run: &RunOutput) -> String {
    let mut s = String::new();
    s.push_str("Analyze this completed k6 run and produce the Markdown report.\n\n");

    s.push_str("## Run metadata\n");
    s.push_str(&format!("- Run ID: `{}`\n", run.run_id));
    if let Some(label) = &run.label {
        if !label.trim().is_empty() {
            s.push_str(&format!("- Label: {}\n", label));
        }
    }
    s.push_str(&format!("- Script: `{}`\n", run.script_path));
    s.push_str(&format!("- Status: `{}`\n", run.status));
    s.push_str(&format!(
        "- Exit code: `{}`\n",
        run.exit_code.map(|c| c.to_string()).unwrap_or_else(|| "—".to_string())
    ));
    s.push_str(&format!("- Started: {}\n", run.started_at.to_rfc3339()));
    if let Some(f) = run.finished_at {
        s.push_str(&format!("- Finished: {}\n", f.to_rfc3339()));
    }
    if let Some(err) = &run.error {
        if !err.trim().is_empty() {
            s.push_str(&format!("- Error: {}\n", err));
        }
    }
    s.push('\n');

    if !run.metrics.is_empty() {
        s.push_str("## Parsed summary metrics\n");
        for m in &run.metrics {
            s.push_str(&format!("- `{}` = `{}`\n", m.name, m.value));
        }
        s.push('\n');
    }

    let stdout_tail = tail_lines(&run.stdout, 80);
    if !stdout_tail.trim().is_empty() {
        s.push_str("## Raw k6 summary (tail of stdout)\n");
        s.push_str("```text\n");
        s.push_str(stdout_tail.trim_end());
        s.push_str("\n```\n\n");
    }

    let stderr_tail = tail_lines(&run.stderr, 40);
    if !stderr_tail.trim().is_empty() {
        s.push_str("## Raw k6 stderr (tail)\n");
        s.push_str("```text\n");
        s.push_str(stderr_tail.trim_end());
        s.push_str("\n```\n\n");
    }

    s.push_str("Now produce the Markdown report per the system instructions.");
    s
}

/// Take the last `n` lines of `text`, prefixing with a marker so the LLM
/// knows the output was truncated.
fn tail_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() <= n {
        return text.to_string();
    }
    let start = lines.len() - n;
    let mut out = String::new();
    out.push_str(&format!("[... {} earlier lines truncated ...]\n", start));
    for line in &lines[start..] {
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// Extract the first fenced ```markdown``` (or generic) block from the LLM
/// response. Falls back to the raw text if no fence is present.
fn extract_markdown(text: &str) -> String {
    // Reuse the script fence extractor — it handles both properly fenced and
    // unterminated LLM responses the same way, and it's the same kind of
    // "recover the actual artifact from chat noise" job.
    let (body, _explanation) = extract_script_and_explanation(text);
    // Treat the extracted body as markdown. If the LLM produced a non-fenced
    // response (extract_script_and_explanation falls back to the whole text),
    // we still get a valid report out the other end.
    body.trim().to_string()
}

/// Dispatch a chat completion to the appropriate provider implementation.
async fn dispatch_chat(
    provider: &LlmProviderConfig,
    messages: &[ChatMessage],
) -> anyhow::Result<(String, String, Option<u32>, Option<u32>)> {
    match provider.provider.as_str() {
        "anthropic" => anthropic_chat(provider, messages).await,
        // OpenAI, Ollama, and any OpenAI-compatible endpoint all use the same wire.
        _ => openai_compat_chat(provider, messages).await,
    }
}

/// OpenAI-compatible chat completions (OpenAI, DeepSeek, Moonshot, OpenRouter, Ollama, custom...).
async fn openai_compat_chat(
    provider: &LlmProviderConfig,
    messages: &[ChatMessage],
) -> anyhow::Result<(String, String, Option<u32>, Option<u32>)> {
    let base = provider.base_url.trim_end_matches('/');
    let url = format!("{}/chat/completions", base);

    let body = serde_json::json!({
        "model": provider.model,
        "temperature": provider.temperature,
        "messages": messages,
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()?;
    let mut req = client.post(&url).json(&body);
    if !provider.api_key.is_empty() {
        req = req.bearer_auth(&provider.api_key);
    }
    if let Some(org) = &provider.organization {
        if !org.is_empty() {
            req = req.header("OpenAI-Organization", org);
        }
    }

    let resp = req.send().await?;
    let status = resp.status();
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        anyhow::bail!("HTTP {} from {}: {}", status, url, txt);
    }
    let json: serde_json::Value = resp.json().await?;
    let model = json
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or(&provider.model)
        .to_string();
    let content = json
        .get("choices")
        .and_then(|v| v.get(0))
        .and_then(|v| v.get("message"))
        .and_then(|v| v.get("content"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let usage = json.get("usage");
    let tin = usage
        .and_then(|u| u.get("prompt_tokens"))
        .and_then(|v| v.as_u64())
        .map(|v| v as u32);
    let tout = usage
        .and_then(|u| u.get("completion_tokens"))
        .and_then(|v| v.as_u64())
        .map(|v| v as u32);
    Ok((content, model, tin, tout))
}

/// Anthropic Messages API.
async fn anthropic_chat(
    provider: &LlmProviderConfig,
    messages: &[ChatMessage],
) -> anyhow::Result<(String, String, Option<u32>, Option<u32>)> {
    let base = provider.base_url.trim_end_matches('/');
    let url = format!("{}/v1/messages", base);

    let mut system = String::new();
    let mut converted: Vec<serde_json::Value> = Vec::new();
    for m in messages {
        match m {
            ChatMessage::System { content } => {
                if !system.is_empty() {
                    system.push('\n');
                }
                system.push_str(content);
            }
            ChatMessage::User { content } => {
                converted.push(serde_json::json!({"role": "user", "content": content}));
            }
            ChatMessage::Assistant { content } => {
                converted.push(serde_json::json!({"role": "assistant", "content": content}));
            }
        }
    }

    let body = serde_json::json!({
        "model": provider.model,
        "max_tokens": 4096,
        "temperature": provider.temperature,
        "system": system,
        "messages": converted,
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()?;
    let req = client
        .post(&url)
        .header("x-api-key", &provider.api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body);

    let resp = req.send().await?;
    let status = resp.status();
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        anyhow::bail!("HTTP {} from {}: {}", status, url, txt);
    }
    let json: serde_json::Value = resp.json().await?;
    let model = json
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or(&provider.model)
        .to_string();
    let content = json
        .get("content")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter()
                .find(|c| c.get("type").and_then(|v| v.as_str()) == Some("text"))
        })
        .and_then(|c| c.get("text"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let usage = json.get("usage");
    let tin = usage
        .and_then(|u| u.get("input_tokens"))
        .and_then(|v| v.as_u64())
        .map(|v| v as u32);
    let tout = usage
        .and_then(|u| u.get("output_tokens"))
        .and_then(|v| v.as_u64())
        .map(|v| v as u32);
    Ok((content, model, tin, tout))
}

fn system_prompt() -> &'static str {
    r#"You are PerfPilot, an expert k6 performance test author. You translate natural-language scenarios into runnable k6 (JavaScript) scripts.

Rules:
1. Output MUST be a single, complete, runnable k6 script.
2. Wrap the script in a ```javascript fenced code block. After the code block, give a 1-3 sentence explanation of the script's load profile (VUs, duration, thresholds).
3. Prefer options.scenarios with executor "ramping-vus" or "constant-vus" for clarity.
4. Use modern k6 patterns: `check()` for assertions, `group()` for grouping, `http.get/http.post` for requests.
5. Always define at least one threshold via `options.thresholds`.
6. Never import external npm packages; k6 only ships with `k6/http`, `k6`, `k6/crypto`, `k6/encoding`, `k6/html`, etc.
7. When the user mentions a base URL, expose it via `const BASE_URL = __ENV.BASE_URL || '...';`
8. Default to safe staging defaults: 10 VUs, 30s duration, p95 < 500ms unless the user specifies otherwise.
"#
}

/// Extract the script (first fenced JS block) and any explanation (text after it).
///
/// Tolerant of malformed responses — trims stray backticks / whitespace from
/// the body so a missing closing fence still produces a runnable script.
fn extract_script_and_explanation(text: &str) -> (String, Option<String>) {
    let mut script: Option<String> = None;
    let mut after: Vec<String> = Vec::new();

    let mut chars = text.chars().peekable();
    let mut pending_tail = String::new();
    while let Some(c) = chars.next() {
        if c != '`' || chars.peek() != Some(&'`') {
            // Outside any fence: collect into pending_tail for later use as
            // explanation text (and to detect non-fence backticks).
            pending_tail.push(c);
            continue;
        }
        // Consume the second backtick; require a third to open a fence.
        chars.next();
        if chars.peek() != Some(&'`') {
            // Stray ` ``  (not a fence). Keep both in pending_tail.
            pending_tail.push('`');
            pending_tail.push('`');
            continue;
        }
        chars.next();
        // Read fence info (e.g. "javascript") up to end of line.
        let mut info = String::new();
        while let Some(&nc) = chars.peek() {
            if nc == '\n' {
                chars.next();
                break;
            }
            info.push(nc);
            chars.next();
        }
        let info = info.trim().to_lowercase();
        let is_code = info == "js"
            || info == "javascript"
            || info == "ts"
            || info == "typescript"
            || info == "md"
            || info == "markdown"
            || (info.is_empty() && script.is_none());

        // Read body up to a closing ```, an isolated stray backtick on its
        // own line, or end-of-input. The stray-backtick heuristic handles
        // LLMs that drop the closing fence and leave a single ` on its own.
        let mut body = String::new();
        let mut closed = false;
        while let Some(nc) = chars.next() {
            if nc == '`' {
                if chars.peek() == Some(&'`') {
                    chars.next();
                    if chars.peek() == Some(&'`') {
                        chars.next();
                        closed = true;
                        break;
                    }
                    body.push('`');
                    body.push('`');
                    continue;
                }
                // Stray ` on its own line: end of script.
                if body.ends_with('\n') && chars.peek() == Some(&'\n') {
                    chars.next(); // consume the newline after stray `
                    closed = true;
                    break;
                }
            }
            body.push(nc);
        }

        // After the fence body (closed or not), any remaining chars belong
        // to subsequent text — capture them as the explanation tail.
        let mut tail = String::new();
        while let Some(c) = chars.next() {
            tail.push(c);
        }

        if is_code {
            let cleaned = sanitize_script(&body);
            if script.is_none() {
                script = Some(cleaned);
                // Explanation = pending_tail (text before the fence) + tail.
                let mut combined = pending_tail.trim().to_string();
                if !combined.is_empty() && !tail.trim().is_empty() {
                    combined.push_str("\n\n");
                }
                combined.push_str(tail.trim());
                after = vec![combined];
                pending_tail.clear();
            } else {
                after.push(sanitize_script(&body));
                after.push(tail.trim().to_string());
                pending_tail.clear();
            }
        } else {
            // Non-code fence — fold it back into pending_tail.
            let mut block = String::from("```");
            block.push_str(&info);
            block.push('\n');
            block.push_str(&body);
            if closed {
                block.push_str("```");
            }
            pending_tail.push_str(&block);
            pending_tail.push_str(&tail);
        }
    }

    let explanation = if !after.is_empty() {
        Some(after.join("\n\n").trim().to_string()).filter(|s| !s.is_empty())
    } else if !pending_tail.trim().is_empty() {
        Some(pending_tail.trim().to_string())
    } else {
        None
    };

    let result = script.unwrap_or_else(|| text.trim().to_string());
    (sanitize_script(&result), explanation)
}

/// Strip stray trailing backticks / fences and trim whitespace so an LLM that
/// drops its closing fence doesn't poison the saved script.
///
/// When the LLM's response is unterminated, the body may run past the script
/// into prose explanations. We cut at the last `}` followed by only
/// whitespace, then strip stray fences.
fn sanitize_script(raw: &str) -> String {
    let mut s = raw.trim().to_string();
    // Strip trailing code-fence markers like "```" or "``".
    while s.ends_with("```") || s.ends_with("``") || s.ends_with('`') {
        if s.ends_with("```") {
            s.truncate(s.len() - 3);
        } else if s.ends_with("``") {
            s.truncate(s.len() - 2);
        } else {
            s.truncate(s.len() - 1);
        }
        s = s.trim_end().to_string();
    }
    // If the body has stray post-script text (no closing fence), cut at the
    // last closing brace at the start of a line so the script ends cleanly.
    if let Some(last_brace) = s.rfind("\n}") {
        // Make sure it's a balanced `}` (we only cut at top-level close braces).
        // Heuristic: take everything up to and including the last `\n}` that
        // is followed by only whitespace / blank lines.
        let after = &s[last_brace + 2..];
        if after.trim().is_empty() {
            s.truncate(last_brace + 2);
        }
    } else if let Some(0) = s.find('}') {
        // Single-line script: cut at first `}`.
        if s[1..].trim().is_empty() {
            s.truncate(2);
        }
    }
    s.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_script() {
        let s = "Here:\n```javascript\nimport http from 'k6/http';\nexport default function() { http.get('https://x'); }\n```\nIt tests X.";
        let (script, explanation) = extract_script_and_explanation(s);
        assert!(script.contains("http.get"));
        assert!(explanation.unwrap_or_default().contains("Here"));
    }

    #[test]
    fn extracts_script_when_fence_unterminated() {
        // LLM dropped the closing fence but ended with a stray backtick +
        // some text after. The parser should still recover a runnable script.
        let s = "```javascript\nimport http from 'k6/http';\nexport default function() { http.get('https://x'); }\n`\nHere's a summary.";
        let (script, _expl) = extract_script_and_explanation(s);
        assert!(script.contains("http.get"), "got: {}", script);
        assert!(!script.ends_with('`'), "trailing backtick leaked: {}", script);
        assert!(!script.contains("Here's"), "explanation leaked: {}", script);
    }

    #[test]
    fn strips_stray_backticks_only() {
        let s = "```javascript\nconsole.log('a');\n```\n`";
        let (script, _) = extract_script_and_explanation(s);
        assert_eq!(script, "console.log('a');");
    }

    fn dummy_run() -> RunOutput {
        RunOutput {
            run_id: "r-test-1".to_string(),
            script_path: "/tmp/smoke.js".to_string(),
            label: Some("smoke".to_string()),
            started_at: chrono::Utc::now(),
            finished_at: Some(chrono::Utc::now()),
            exit_code: Some(0),
            status: "passed".to_string(),
            stdout: "running (30s), 50/50 VUs\nhttp_req_duration..............: avg=120ms min=80ms med=110ms max=300ms p(90)=180ms p(95)=210ms\nhttp_reqs......................: 532 53.2/s".to_string(),
            stderr: "".to_string(),
            metrics: vec![
                crate::k6::MetricSummary { name: "http_req_duration".into(), value: "120ms".into(), unit: Some("ms".into()) },
                crate::k6::MetricSummary { name: "http_reqs".into(), value: "532".into(), unit: None },
            ],
            error: None,
        }
    }

    #[test]
    fn report_user_prompt_includes_metrics_and_tail() {
        let run = dummy_run();
        let prompt = build_report_user_prompt(&run);
        assert!(prompt.contains("r-test-1"));
        assert!(prompt.contains("smoke"));
        assert!(prompt.contains("http_req_duration"));
        assert!(prompt.contains("http_reqs"));
        assert!(prompt.contains("http_req_duration.............."));
        assert!(prompt.contains("Now produce the Markdown report"));
    }

    #[test]
    fn report_user_prompt_handles_missing_optional_fields() {
        let mut run = dummy_run();
        run.label = None;
        run.error = None;
        run.metrics.clear();
        run.finished_at = None;
        run.exit_code = None;
        run.stderr = "".into();
        run.stdout = "".into();
        let prompt = build_report_user_prompt(&run);
        assert!(prompt.contains("Run ID: `r-test-1`"));
        assert!(!prompt.contains("Label:"));
        assert!(!prompt.contains("Error:"));
        assert!(!prompt.contains("Parsed summary metrics"));
        assert!(!prompt.contains("Raw k6 summary"));
        assert!(!prompt.contains("Raw k6 stderr"));
    }

    #[test]
    fn report_system_prompt_directs_language() {
        let en = build_report_system_prompt("en");
        assert!(en.contains("English"), "en prompt should require English: {}", en);
        assert!(!en.contains("Simplified Chinese"), "en prompt must not require Chinese");

        let zh = build_report_system_prompt("zh-CN");
        assert!(zh.contains("简体中文"), "zh prompt should require Chinese: {}", zh);
        assert!(!zh.contains("Write the entire report in English."));
    }

    #[test]
    fn report_system_prompt_default_is_english() {
        // Unknown locale falls back to English so we don't ship bilingual mush.
        let s = build_report_system_prompt("fr-FR");
        assert!(s.contains("English"));
    }

    #[test]
    fn tail_lines_returns_full_text_when_short() {
        let s = "a\nb\nc";
        assert_eq!(tail_lines(s, 10), "a\nb\nc");
    }

    #[test]
    fn tail_lines_truncates_with_marker() {
        let s = (1..=20).map(|i| format!("line {}", i)).collect::<Vec<_>>().join("\n");
        let t = tail_lines(&s, 3);
        assert!(t.contains("earlier lines truncated"));
        assert!(t.contains("line 18"));
        assert!(t.contains("line 20"));
        assert!(!t.contains("line 1\n"));
    }

    #[test]
    fn extract_markdown_recovers_fenced_block() {
        let s = "```markdown\n# Hello\n\nWorld\n```";
        assert_eq!(extract_markdown(s), "# Hello\n\nWorld");
    }

    #[test]
    fn extract_markdown_falls_back_to_raw_text() {
        let s = "# Just a heading\n\nNo fence here.";
        assert_eq!(extract_markdown(s), "# Just a heading\n\nNo fence here.");
    }

    #[test]
    fn extract_markdown_strips_stray_trailing_fence() {
        let s = "```markdown\n# Hello\n```\n`";
        assert_eq!(extract_markdown(s), "# Hello");
    }
}