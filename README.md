# PerfPilot

> AI-native desktop performance testing platform — **Tauri 2 + Vue 3 + k6**.

[简体中文](./README.zh-CN.md)

PerfPilot turns natural-language intents into runnable k6 load-test scripts, lets you edit them with Monaco, configure LLM providers, and stream real-time test output from your desktop.

## Features

- 🚀 **k6 engine** — runs `k6 run` directly from the desktop, streams stdout/stderr to the UI. k6 ships inside the app; no separate install required.
- 🪄 **AI script generation** — describe a scenario in plain language, get a complete k6 script (HTTP, RPS, scenarios, thresholds, checks).
- 🧠 **Pluggable LLMs** — OpenAI-compatible, Anthropic, Ollama, or any custom OpenAI-compatible endpoint (DeepSeek, Moonshot, OpenRouter, etc.).
- 🖥️ **Monaco Editor** — IntelliSense-ish k6 JavaScript editing, themes, multi-tab.
- 📊 **Live metrics** — captures k6 summary metrics and renders them in-app.
- 💾 **Local-first** — scripts, runs, and configs persisted via the Tauri store plugin.

## Stack

| Layer | Tech |
| --- | --- |
| Desktop shell | **Tauri 2** (Rust) |
| UI | **Vue 3** + **TypeScript** + **Vite** |
| State | **Pinia** |
| Design system | **shadcn-vue / Reka UI** + **Tailwind CSS** |
| Code editor | **Monaco Editor** |
| Load engine | **k6** (CLI, bundled as a Tauri sidecar) |
| LLM transport | `reqwest` (Rust) for OpenAI-compatible chat completions |

## Project layout

```
perf-pilot/
├── src/                       # Vue 3 frontend
├── src-tauri/                 # Rust backend
│   └── src/
│       ├── k6.rs              # k6 runner + sidecar resolution
│       ├── llm.rs             # LLM provider clients
│       ├── llm_stream.rs      # SSE stream parser
│       ├── fs.rs              # script / run-record IO
│       └── settings.rs        # app settings persistence
├── e2e/                       # Playwright e2e (mock Tauri IPC)
└── scripts/                   # fetch-k6.sh, build-dmg.sh
```

## Download

Grab the latest installers from the [Releases](https://github.com/Souanine/perf-pilot/releases) page:

| Platform | File |
| --- | --- |
| macOS Apple Silicon | `PerfPilot-0.1.0-arm64.dmg` |
| Windows x64 | `PerfPilot_0.1.0_x64-setup.exe` |

## Quick start (development)

```bash
npm install
scripts/fetch-k6.sh        # fetch the per-platform k6 sidecar (~60 MB, gitignored)
npm run tauri:dev          # launches the desktop app
```

For a local production build:

```bash
npm run tauri:build        # .app (macOS) or .exe (Windows)
npm run tauri:release-dmg  # .app + .dmg on macOS only
```

For cross-platform release builds (and to publish installers), see [CONTRIBUTING.md → Releasing](./CONTRIBUTING.md#releasing).

## System requirements

| Platform | Minimum |
| --- | --- |
| macOS | 10.13+ (tested on macOS 26 Tahoe, arm64) |
| Windows | 10 / 11 x64 (NSIS installer) |
| Linux | x64 / arm64 (k6 sidecar script supports both; not currently a release target) |

For development only:

- **Rust** 1.77+
- **Node** 18+ and **npm** 9+

k6 is bundled — no separate install. To use a custom k6 build, set the `K6_PATH` environment variable.

## License

MIT. See [`LICENSE`](./LICENSE).

## Acknowledgements

- [Tauri](https://tauri.app/) — Rust + WebView desktop shell
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) — VS Code's editor
- [k6](https://k6.io/) — modern load-testing engine in Go