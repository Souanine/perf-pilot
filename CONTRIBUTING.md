# Contributing

Project internals for people editing this repo. End users should read [README.md](./README.md) instead.

## Development setup

```bash
git clone ...
cd perf-pilot
npm install
scripts/fetch-k6.sh              # drops k6 into src-tauri/binaries/
npm run tauri:dev
```

The k6 sidecar binary (~60 MB) is **gitignored** — every clone or k6 version bump needs `scripts/fetch-k6.sh` to populate `src-tauri/binaries/`. The script reads `rustc -vV` host triple and downloads the matching GitHub release asset for darwin / linux / windows.

## Tests

Three layers, each scoped to a different concern:

| Layer | Command | What it covers |
| --- | --- | --- |
| Vue component / Pinia store | `npm run test` | Pure logic; jsdom |
| Rust backend | `cargo test --lib` (from `src-tauri/`) | k6 parser, SSE parser, index helpers, sidecar resolution |
| End-to-end (browser) | `npm run test:e2e` | Real Vue + Pinia + Router against the Vite dev server, Tauri IPC stubbed via `window.__TAURI_INTERNALS__` |
| Accessibility scan (axe) | `npm run test:e2e e2e/tests/a11y.spec.ts` | WCAG 2.1 AA, all 6 routes |

Current counts: **47 cargo unit tests**, **9 Playwright spec files**, **1 a11y spec** (across 6 routes).

### End-to-end strategy (deliberate tradeoff)

The e2e suite drives the **Vite dev server**, not the Tauri binary. Tauri IPC is stubbed by `e2e/mock-tauri.ts`, which injects a fake `window.__TAURI_INTERNALS__` that satisfies the same protocol the real backend speaks (`@tauri-apps/plugin-store` reads/writes, `plugin:event` emits, SSE chunk dispatching for streaming LLM).

**Why Vite instead of WebDriver against a Tauri WebView?**

- Each spec iterates in <10 s. A real WebDriver harness through the Tauri shell is seconds-per-step.
- Vue/Pinia/Router flows are exercised end-to-end — the parts most likely to regress.

**What this misses**: bugs that only show up in release builds — Tauri IPC quirks, native dialogs, k6 spawn, notarization. These are caught by:

- `cargo test --lib` for the Rust side
- Manual `computer-use` runs against the release DMG before each PR

If you add a new `#[tauri::command]`, also stub it in `e2e/mock-tauri.ts` — missing stubs throw `not implemented` and break specs that touch the new command.

### e2e layout

```
e2e/
├── playwright.config.ts        # boots Vite dev server, headless chromium
├── mock-tauri.ts               # IPC shim (plugin-store + plugin:event + SSE)
├── fixtures.ts / helpers.ts    # page fixtures + helpers
└── tests/                      # specs grouped by area
    ├── navigation.spec.ts
    ├── dashboard.spec.ts
    ├── runs.spec.ts
    ├── history.spec.ts
    ├── settings.spec.ts
    ├── ai-generate.spec.ts
    ├── streaming.spec.ts
    ├── a11y.spec.ts
    └── theme+locale.spec.ts
```

Playwright parallelism is disabled in `playwright.config.ts` because the `installTauriMocks` fixture has shared mutable state. Re-enable only after auditing the fixture.

### First-time e2e setup

```bash
npx playwright install chromium   # one-time per machine
npm run test:e2e
```

## Architecture

See [AGENTS.md](./AGENTS.md) for the full breakdown (paths, conventions, sidecar gotchas). Highlights:

- **k6 detection**: `k6::which_k6()` in Rust, in priority order — `K6_PATH` (user override) → `PERFPILOT_K6_BIN` (sidecar, set by `lib::run` setup) → common system paths → `command -v k6` via PATH.
- **Sidecar filename**: `k6-<rustc-target-triple>[.exe]`. Apple Silicon: `k6-aarch64-apple-darwin`. Windows: `k6-x86_64-pc-windows-msvc.exe`. The triple is exported by `src-tauri/build.rs` as `PERFPILOT_TARGET_TRIPLE`.
- **LLM transport**: `LlmProviderConfig` carries the format (`openai_completions` / `anthropic_messages` / `openai_responses`) + model catalog. `llm.rs` for non-streaming, `llm_stream.rs` for SSE parsing.
- **State**: Pinia stores under `src/stores/`, persistence via `@tauri-apps/plugin-store`.

## Conventions

- Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `ci:`). See `git log --oneline` for examples.
- Frontend state goes in Pinia stores, not in components. Composables (`src/composables/`) for cross-component reactive logic.
- Rust errors returned from `#[tauri::command]` are `Result<T, String>` — stringified for IPC.
- Don't commit `src-tauri/binaries/*`. Gitignored.
- Comments only when they state a constraint the code can't show. Don't narrate-the-line.

## Real-LLM smoke test (pre-PR)

Before opening a PR that touches LLM code, do a manual `computer-use` run against a release build:

```bash
# macOS
open src-tauri/target/release/bundle/macos/PerfPilot.app
# → click AI 生成 / Generate → enter a scenario → trigger generate_script_stream
# → confirm chunks stream into Monaco without errors
```

A reasonable target: <5 s to first chunk, <10 s to a complete script for a one-screen scenario. If it regresses, investigate before merging.

## Releasing

Releases are fully automated via `.github/workflows/release.yml`. No manual signing/notarization yet.

```bash
git tag v0.1.x
git push --tags
```

That triggers:

1. **Build matrix** (parallel):
   - `macos-latest` → `tauri build --target aarch64-apple-darwin` → DMG via `scripts/build-dmg.sh`
   - `windows-latest` → install NSIS via `choco` → `tauri build --target x86_64-pc-windows-msvc`
2. **Artifact upload** per platform (~37 MB DMG, ~30 MB NSIS installer).
3. **`release` job** (Ubuntu, only on tag push) — downloads both artifacts and publishes a GitHub Release via `softprops/action-gh-release@v2`. Re-runs via `workflow_dispatch` do NOT publish.

To re-run a broken build without publishing, use **Run workflow** from the Actions tab — that's `workflow_dispatch`, which skips the release job.

To bump k6:

```bash
K6_VERSION=v2.4.0 scripts/fetch-k6.sh
# ... commit any script changes, push, tag
```

The k6 binary itself stays out of git (gitignored).