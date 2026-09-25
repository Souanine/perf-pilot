# PerfPilot

> AI-native desktop performance testing platform — **Tauri 2 + Vue 3 + k6**.

[简体中文](./README.zh-CN.md)

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

## Tests

Three layers, each with a different scope:

| Layer | Command | What it covers |
|---|---|---|
| Vue component / Pinia store | `npm run test` | Pure logic; jsdom |
| Rust backend | `cargo test --lib` (from `src-tauri/`) | k6 parser, SSE parser, index helpers |
| End-to-end (browser) | `npm run test:e2e` | Real Vue + Pinia + Router against the Vite dev server, with Tauri IPC stubbed via `window.__TAURI_INTERNALS__` |

The e2e suite needs a browser binary. After a fresh install:

```bash
npx playwright install chromium
npm run test:e2e
```

Layout under `e2e/`:

- `playwright.config.ts` — config (boots the Vite dev server, runs chromium headless)
- `mock-tauri.ts` — IPC shim, including the full `@tauri-apps/plugin-store` protocol
- `fixtures.ts` / `helpers.ts` — fixtures + page helpers
- `tests/*.spec.ts` — specs grouped by area (navigation, dashboard, runs, history, settings, ai-generate, theme+locale)

The e2e suite intentionally drives the Vite dev server (not the Tauri binary) — it covers Vue/Pinia/router flows end-to-end, while real Rust behaviour is owned by `cargo test`. This keeps iteration under 10 seconds per spec instead of seconds-per-step WebDriver overhead.
