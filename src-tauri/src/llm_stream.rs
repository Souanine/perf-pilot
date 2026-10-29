//! Streaming variant of the LLM client.
//!
//! All three provider families (OpenAI Chat Completions, Anthropic Messages,
//! OpenAI Responses) speak SSE for streaming. The wire shapes differ but the
//! outer framing (`data: <json>\n\n` for OpenAI, `event: …\ndata: <json>\n\n`
//! for Anthropic/Responses) is uniform enough that one small parser handles
//! them all.
//!
//! Each streaming call emits `llm://chunk` events tagged with a
//! caller-supplied `request_id` so the frontend can interleave several
//! concurrent streams without confusion. The first event for a given id is
//! always `started`, intermediate events are `delta` (raw text fragment),
//! and the terminal event is `done` (with the assembled text + token usage)
//! or `error`.

use crate::llm::{
    build_report_user_prompt, build_report_system_prompt, dispatch_chat,
    extract_markdown, extract_script_and_explanation, ApiFormat, ChatMessage,
    LlmProviderConfig, ReportGenResponse, ScriptGenRequest, ScriptGenResponse,
};
use crate::k6::RunOutput;
use anyhow::Context;
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::Value;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::Emitter;

/// Event payload emitted to the frontend on the `llm://chunk` channel.
#[derive(Debug, Serialize, Clone)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum LlmStreamEvent {
    /// Emitted once before any `delta`. Carries the model id so the UI can
    /// show a token before the first chunk lands.
    Started {
        request_id: String,
        model: String,
    },
    /// A chunk of the in-progress response. The frontend appends verbatim.
    Delta { request_id: String, text: String },
    /// Terminal event on success. `text` is the full assembled body.
    Done {
        request_id: String,
        text: String,
        model: String,
        tokens_in: Option<u32>,
        tokens_out: Option<u32>,
    },
    /// Terminal event on failure. Subsequent events for the same id should
    /// be ignored.
    Error { request_id: String, message: String },
}

/// Shared `reqwest::Client` for all LLM HTTP calls.
///
/// Building a Client is non-trivial: TLS config, connection pool, optional
/// HTTP/2. The streaming variants below benefit the most (a long-lived
/// response with many reads wants keep-alive), but the non-streaming
/// `dispatch_chat` would benefit too — `llm.rs` builds one per call today.
/// Centralising here means a future `dispatch_chat` rewrite only needs to
/// import `llm_client()` instead of changing every call site.
pub fn llm_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(300))
            .connect_timeout(Duration::from_secs(15))
            .pool_max_idle_per_host(8)
            .build()
            .expect("reqwest client builds with defaults")
    })
}

/// A piece of the assembled SSE stream: either a named event with a JSON
/// payload (Anthropic / Responses) or a raw `data:` payload (OpenAI).
#[derive(Debug, Default)]
pub struct SseFrame {
    event: Option<String>,
    data: Option<String>,
}

/// Minimal SSE parser. Reads bytes off the wire, splits on `\n\n`, and
/// yields one [`SseFrame`] per event. Lines beginning with `:` are SSE
/// comments and are silently dropped.
pub struct SseParser {
    buffer: String,
}

impl SseParser {
    pub fn new() -> Self {
        Self {
            buffer: String::new(),
        }
    }

    /// Push a chunk of raw bytes; return any complete frames.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseFrame> {
        self.buffer.push_str(&String::from_utf8_lossy(chunk));
        let mut frames = Vec::new();
        while let Some(idx) = self.buffer.find("\n\n") {
            let raw: String = self.buffer.drain(..idx + 2).collect();
            let mut frame = SseFrame::default();
            for line in raw.split('\n') {
                let line = line.trim_end_matches('\r');
                if line.is_empty() || line.starts_with(':') {
                    continue;
                }
                if let Some(rest) = line.strip_prefix("event:") {
                    frame.event = Some(rest.trim().to_string());
                } else if let Some(rest) = line.strip_prefix("data:") {
                    let payload = rest.trim();
                    if let Some(prev) = frame.data.as_mut() {
                        prev.push('\n');
                        prev.push_str(payload);
                    } else {
                        frame.data = Some(payload.to_string());
                    }
                }
                // Other fields (id:, retry:) are ignored — we don't use them.
            }
            if frame.data.is_some() || frame.event.is_some() {
                frames.push(frame);
            }
        }
        frames
    }

    pub fn finish(self) -> Vec<SseFrame> {
        // Flush whatever is in the buffer at EOF. Any trailing partial frame
        // is treated as a complete one so callers don't silently drop the
        // last delta if the server doesn't terminate with a blank line.
        if self.buffer.trim().is_empty() {
            return Vec::new();
        }
        let mut frame = SseFrame::default();
        for line in self.buffer.split('\n') {
            let line = line.trim_end_matches('\r');
            if line.is_empty() || line.starts_with(':') {
                continue;
            }
            if let Some(rest) = line.strip_prefix("event:") {
                frame.event = Some(rest.trim().to_string());
            } else if let Some(rest) = line.strip_prefix("data:") {
                frame.data = Some(rest.trim().to_string());
            }
        }
        if frame.data.is_some() || frame.event.is_some() {
            vec![frame]
        } else {
            Vec::new()
        }
    }
}

/// Pull just the assistant text out of a streaming SSE payload for the
/// given provider family. Returns `None` if the frame carries no text.
fn extract_delta(format: ApiFormat, event: Option<&str>, data: &str) -> Option<String> {
    if data == "[DONE]" {
        return None;
    }
    let json: Value = serde_json::from_str(data).ok()?;
    match format {
        // OpenAI chat completions: choices[0].delta.content
        ApiFormat::ChatCompletions => json
            .get("choices")
            .and_then(|v| v.get(0))
            .and_then(|v| v.get("delta"))
            .and_then(|v| v.get("content"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        // Anthropic: event == "content_block_delta" → delta.text
        ApiFormat::AnthropicMessages => {
            if event != Some("content_block_delta") {
                return None;
            }
            json.get("delta")
                .and_then(|v| v.get("text"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        }
        // OpenAI Responses: event == "response.output_text.delta" → delta
        ApiFormat::Responses => {
            if event != Some("response.output_text.delta") {
                return None;
            }
            json.get("delta")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        }
    }
}

/// Drive a streaming POST against `url`, emit `Delta` events for each
/// extracted text fragment, and return the assembled full body plus the
/// provider-reported model id (the model is read from the response, falling
/// back to `provider.model` when the server doesn't echo it).
async fn stream_request(
    window: &tauri::Window,
    request_id: &str,
    provider: &LlmProviderConfig,
    url: &str,
    body: Value,
    extra_headers: &[(&str, &str)],
) -> anyhow::Result<(String, String, Option<u32>, Option<u32>)> {
    let client = llm_client();
    let mut req = client.post(url).json(&body);
    if !provider.api_key.is_empty() {
        req = req.bearer_auth(&provider.api_key);
    }
    if let Some(org) = &provider.organization {
        if !org.is_empty() {
            req = req.header("OpenAI-Organization", org);
        }
    }
    for (k, v) in extra_headers {
        req = req.header(*k, *v);
    }

    let resp = req.send().await.context("LLM request failed")?;
    let status = resp.status();
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        let msg = format!("HTTP {} from {}: {}", status, url, txt);
        let _ = window.emit(
            "llm://chunk",
            LlmStreamEvent::Error {
                request_id: request_id.to_string(),
                message: msg.clone(),
            },
        );
        anyhow::bail!(msg);
    }

    // The provider-reported model is in either the first SSE event or (more
    // commonly) we just echo the configured model.
    let model_hint = provider.model.clone();
    let mut model = model_hint.clone();
    let mut tin: Option<u32> = None;
    let mut tout: Option<u32> = None;

    let mut assembled = String::new();
    let mut parser = SseParser::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                let msg = format!("stream read error: {}", e);
                let _ = window.emit(
                    "llm://chunk",
                    LlmStreamEvent::Error {
                        request_id: request_id.to_string(),
                        message: msg.clone(),
                    },
                );
                anyhow::bail!(msg);
            }
        };
        let frames = parser.push(&chunk);
        for frame in frames {
            let data = match frame.data.as_deref() {
                Some(d) => d,
                None => continue,
            };
            // Capture usage if the provider surfaces it mid-stream.
            if let Ok(v) = serde_json::from_str::<Value>(data) {
                if let Some(m) = v.get("model").and_then(|x| x.as_str()) {
                    model = m.to_string();
                }
                if let Some(u) = v.get("usage") {
                    if tin.is_none() {
                        tin = u
                            .get("prompt_tokens")
                            .or_else(|| u.get("input_tokens"))
                            .and_then(|x| x.as_u64())
                            .map(|x| x as u32);
                    }
                    if tout.is_none() {
                        tout = u
                            .get("completion_tokens")
                            .or_else(|| u.get("output_tokens"))
                            .and_then(|x| x.as_u64())
                            .map(|x| x as u32);
                    }
                }
            }
            if let Some(delta) = extract_delta(provider.api_format, frame.event.as_deref(), data) {
                assembled.push_str(&delta);
                let _ = window.emit(
                    "llm://chunk",
                    LlmStreamEvent::Delta {
                        request_id: request_id.to_string(),
                        text: delta,
                    },
                );
            }
        }
    }
    // Flush any trailing partial frame.
    for frame in parser.finish() {
        if let Some(data) = frame.data.as_deref() {
            if let Some(delta) = extract_delta(provider.api_format, frame.event.as_deref(), data) {
                assembled.push_str(&delta);
                let _ = window.emit(
                    "llm://chunk",
                    LlmStreamEvent::Delta {
                        request_id: request_id.to_string(),
                        text: delta,
                    },
                );
            }
        }
    }
    if model.is_empty() {
        model = model_hint;
    }
    Ok((assembled, model, tin, tout))
}

/// Streaming variant of `generate_script`.
#[allow(clippy::too_many_arguments)]
pub async fn generate_script_stream(
    window: tauri::Window,
    request_id: String,
    provider: LlmProviderConfig,
    request: ScriptGenRequest,
    history: Vec<ChatMessage>,
) -> anyhow::Result<ScriptGenResponse> {
    let (messages, model_hint) = build_script_messages(&provider, &request, history);

    let base = provider.base_url.trim_end_matches('/');
    let (url, body, extra) = match provider.api_format {
        ApiFormat::ChatCompletions => (
            format!("{}/chat/completions", base),
            serde_json::json!({
                "model": provider.model,
                "temperature": provider.temperature,
                "messages": messages,
                "stream": true,
                "stream_options": { "include_usage": true },
            }),
            vec![] as Vec<(&str, &str)>,
        ),
        ApiFormat::AnthropicMessages => {
            let (system, converted) = split_system(&messages);
            (
                format!("{}/v1/messages", base),
                serde_json::json!({
                    "model": provider.model,
                    "max_tokens": 4096,
                    "temperature": provider.temperature,
                    "system": system,
                    "messages": converted,
                    "stream": true,
                }),
                vec![
                    ("x-api-key", provider.api_key.as_str()),
                    ("anthropic-version", "2023-06-01"),
                ],
            )
        }
        ApiFormat::Responses => {
            // Responses API: input is an array of role/content items; the
            // first system item carries any system prompt.
            let mut input: Vec<Value> = Vec::new();
            let mut system_buf = String::new();
            for m in &messages {
                match m {
                    ChatMessage::System { content } => {
                        if !system_buf.is_empty() {
                            system_buf.push('\n');
                        }
                        system_buf.push_str(content);
                    }
                    ChatMessage::User { content } => {
                        if !system_buf.is_empty() {
                            input.push(serde_json::json!({"role": "system", "content": system_buf}));
                            system_buf.clear();
                        }
                        input.push(serde_json::json!({"role": "user", "content": content}));
                    }
                    ChatMessage::Assistant { content } => {
                        if !system_buf.is_empty() {
                            input.push(serde_json::json!({"role": "system", "content": system_buf}));
                            system_buf.clear();
                        }
                        input.push(serde_json::json!({"role": "assistant", "content": content}));
                    }
                }
            }
            if !system_buf.is_empty() {
                input.push(serde_json::json!({"role": "system", "content": system_buf}));
            }
            (
                format!("{}/responses", base),
                serde_json::json!({
                    "model": provider.model,
                    "temperature": provider.temperature,
                    "input": input,
                    "stream": true,
                }),
                vec![] as Vec<(&str, &str)>,
            )
        }
    };

    let _ = window.emit(
        "llm://chunk",
        LlmStreamEvent::Started {
            request_id: request_id.clone(),
            model: model_hint.clone(),
        },
    );

    let (text, model, tin, tout) = stream_request(&window, &request_id, &provider, &url, body, &extra).await?;
    let (script, explanation) = extract_script_and_explanation(&text);
    let response = ScriptGenResponse {
        script,
        explanation,
        model,
        tokens_in: tin,
        tokens_out: tout,
    };
    let _ = window.emit(
        "llm://chunk",
        LlmStreamEvent::Done {
            request_id,
            text: response.script.clone(),
            model: response.model.clone(),
            tokens_in: response.tokens_in,
            tokens_out: response.tokens_out,
        },
    );
    Ok(response)
}

/// Streaming variant of `generate_report`.
pub async fn generate_report_stream(
    window: tauri::Window,
    request_id: String,
    provider: LlmProviderConfig,
    run: RunOutput,
    locale: String,
) -> anyhow::Result<ReportGenResponse> {
    let system = build_report_system_prompt(&locale);
    let prompt = build_report_user_prompt(&run);
    let messages = vec![
        ChatMessage::System { content: system },
        ChatMessage::User { content: prompt },
    ];

    let base = provider.base_url.trim_end_matches('/');
    let (url, body, extra) = match provider.api_format {
        ApiFormat::ChatCompletions => (
            format!("{}/chat/completions", base),
            serde_json::json!({
                "model": provider.model,
                "temperature": provider.temperature,
                "messages": messages,
                "stream": true,
                "stream_options": { "include_usage": true },
            }),
            vec![] as Vec<(&str, &str)>,
        ),
        ApiFormat::AnthropicMessages => {
            let (system, converted) = split_system(&messages);
            (
                format!("{}/v1/messages", base),
                serde_json::json!({
                    "model": provider.model,
                    "max_tokens": 4096,
                    "temperature": provider.temperature,
                    "system": system,
                    "messages": converted,
                    "stream": true,
                }),
                vec![
                    ("x-api-key", provider.api_key.as_str()),
                    ("anthropic-version", "2023-06-01"),
                ],
            )
        }
        ApiFormat::Responses => {
            let mut input: Vec<Value> = Vec::new();
            for m in &messages {
                let role = match m {
                    ChatMessage::System { .. } => "system",
                    ChatMessage::User { .. } => "user",
                    ChatMessage::Assistant { .. } => "assistant",
                };
                let content = match m {
                    ChatMessage::System { content }
                    | ChatMessage::User { content }
                    | ChatMessage::Assistant { content } => content,
                };
                input.push(serde_json::json!({"role": role, "content": content}));
            }
            (
                format!("{}/responses", base),
                serde_json::json!({
                    "model": provider.model,
                    "temperature": provider.temperature,
                    "input": input,
                    "stream": true,
                }),
                vec![] as Vec<(&str, &str)>,
            )
        }
    };

    let _ = window.emit(
        "llm://chunk",
        LlmStreamEvent::Started {
            request_id: request_id.clone(),
            model: provider.model.clone(),
        },
    );

    let (text, model, tin, tout) =
        stream_request(&window, &request_id, &provider, &url, body, &extra).await?;
    let report = extract_markdown(&text);
    let response = ReportGenResponse {
        report,
        model,
        tokens_in: tin,
        tokens_out: tout,
    };
    let _ = window.emit(
        "llm://chunk",
        LlmStreamEvent::Done {
            request_id,
            text: response.report.clone(),
            model: response.model.clone(),
            tokens_in: response.tokens_in,
            tokens_out: response.tokens_out,
        },
    );
    Ok(response)
}

/// Build the message list for a script-generation call. Pulled out so the
/// streaming and non-streaming paths stay aligned.
pub fn build_script_messages(
    provider: &LlmProviderConfig,
    request: &ScriptGenRequest,
    history: Vec<ChatMessage>,
) -> (Vec<ChatMessage>, String) {
    use crate::llm::{compose_script_user_prompt, system_prompt};
    let mut messages = vec![ChatMessage::System {
        content: system_prompt().to_string(),
    }];
    messages.push(ChatMessage::User {
        content: compose_script_user_prompt(request),
    });
    for m in history {
        messages.push(m);
    }
    (messages, provider.model.clone())
}

/// Split a mixed message list into Anthropic's `(system, Vec<Value>)`
/// shape. Used by both streaming and any future non-streaming Anthropic
/// rewrite.
fn split_system(messages: &[ChatMessage]) -> (String, Vec<Value>) {
    let mut system = String::new();
    let mut converted: Vec<Value> = Vec::new();
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
    (system, converted)
}

/// Non-streaming fallback used when callers don't supply a `Window`. Today
/// only the test module needs this; keeping it here means the streaming
/// and non-streaming code paths are unified.
pub async fn generate_script_blocking(
    provider: &LlmProviderConfig,
    request: &ScriptGenRequest,
    history: Vec<ChatMessage>,
) -> anyhow::Result<ScriptGenResponse> {
    let (messages, _) = build_script_messages(provider, request, history);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_parser_splits_on_blank_line() {
        let mut p = SseParser::new();
        let frames = p.push(b"data: hello\n\n");
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].data.as_deref(), Some("hello"));
    }

    #[test]
    fn sse_parser_handles_split_chunks() {
        let mut p = SseParser::new();
        let frames = p.push(b"data: hel");
        assert!(frames.is_empty());
        let frames = p.push(b"lo\n\ndata: world\n\n");
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].data.as_deref(), Some("hello"));
        assert_eq!(frames[1].data.as_deref(), Some("world"));
    }

    #[test]
    fn sse_parser_drops_comments() {
        let mut p = SseParser::new();
        let frames = p.push(b": ping\n\ndata: real\n\n");
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].data.as_deref(), Some("real"));
    }

    #[test]
    fn sse_parser_carries_event_field() {
        let mut p = SseParser::new();
        let frames = p.push(b"event: content_block_delta\ndata: {\"x\":1}\n\n");
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].event.as_deref(), Some("content_block_delta"));
        assert_eq!(frames[0].data.as_deref(), Some("{\"x\":1}"));
    }

    #[test]
    fn sse_parser_finisher_flushes_partial() {
        let mut p = SseParser::new();
        let _ = p.push(b"data: tail");
        let frames = p.finish();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].data.as_deref(), Some("tail"));
    }

    #[test]
    fn extract_delta_chat_completions() {
        let v = serde_json::json!({"choices": [{"delta": {"content": "hi"}}]});
        let data = serde_json::to_string(&v).unwrap();
        assert_eq!(
            extract_delta(ApiFormat::ChatCompletions, None, &data).as_deref(),
            Some("hi")
        );
    }

    #[test]
    fn extract_delta_anthropic_requires_event() {
        let v = serde_json::json!({"delta": {"text": "hi"}});
        let data = serde_json::to_string(&v).unwrap();
        assert!(extract_delta(ApiFormat::AnthropicMessages, Some("ping"), &data).is_none());
        assert_eq!(
            extract_delta(ApiFormat::AnthropicMessages, Some("content_block_delta"), &data)
                .as_deref(),
            Some("hi")
        );
    }

    #[test]
    fn extract_delta_responses_requires_event() {
        let v = serde_json::json!({"delta": "hi"});
        let data = serde_json::to_string(&v).unwrap();
        assert!(extract_delta(ApiFormat::Responses, None, &data).is_none());
        assert_eq!(
            extract_delta(ApiFormat::Responses, Some("response.output_text.delta"), &data)
                .as_deref(),
            Some("hi")
        );
    }

    #[test]
    fn extract_delta_handles_done_sentinel() {
        assert!(extract_delta(ApiFormat::ChatCompletions, None, "[DONE]").is_none());
    }
}
