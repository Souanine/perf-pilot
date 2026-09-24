# PerfPilot

> AI-native desktop performance testing platform — **Tauri 2 + Vue 3 + k6**.

PerfPilot turns natural-language intents into runnable k6 load-test scripts, lets you edit them with Monaco, configure LLM providers, and stream real-time test output from your desktop.

## Features

- 🚀 **k6 engine** — runs `k6 run` directly from the desktop, streams stdout/stderr to the UI
- 🪄 **AI script generation** — describe a scenario in plain language, get a complete `k6` script (HTTP, RPS, scenarios, thresholds, checks)
- 🧠 **Pluggable LLMs** — OpenAI-compatible, Anthropic, Ollama, or any custom OpenAI-compatible endpoint (DeepSeek, Moonshot, OpenRouter, etc.)
- 🖥️ **Monaco Editor** — full IntelliSense-ish k6 JavaScript editing, themes, multi-tab
- 📊 **Live metrics** — captures k6 summary metrics and renders them in-app
- 💾 **Local-first** — scripts, runs, and configs persisted via the Tauri store plugin

## Stack

| Layer            | Tech                                                    |
| ---------------- | ------------------------------------------------------- |
| Desktop shell    | **Tauri 2** (Rust)                                     |
| UI               | **Vue 3** + **TypeScript** + **Vite**                 |
| State            | **Pinia**                                              |
| Design system    | **shadcn-vue / Reka UI** + **Tailwind CSS**          |
| Code editor      | **Monaco Editor**                                      |
| Load engine      | **k6** (CLI, invoked via Rust)                          |
| LLM transport    | `reqwest` (Rust) for OpenAI-compatible chat completions |

## Project layout

```
perf-pilot/
├── src/                       # Vue 3 frontend
│   ├── components/
│   ├── pages/
│   ├── stores/                # Pinia
│   ├── lib/                   # Tauri IPC, utils
│   ├── router.ts
│   └── main.ts
├── src-tauri/                 # Rust backend
│   ├── src/
│   │   ├── main.rs
│   │   ├── lib.rs
│   │   ├── k6.rs              # k6 runner
│   │   ├── llm.rs             # LLM provider clients
│   │   ├── fs.rs              # script IO
│   │   └── settings.rs        # app settings persistence
│   ├── Cargo.toml
│   └── tauri.conf.json
└── ...
```

## Development

```bash
npm install
npm run tauri:dev          # launches the desktop app
```

## Production build

```bash
npm run tauri:build
```