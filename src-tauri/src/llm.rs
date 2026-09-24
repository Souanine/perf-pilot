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
}