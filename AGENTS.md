# PerfPilot — Agent Notes

> Quick orientation for future agents editing this repo. Keep additions project-specific, not generic.

## What this is

Tauri 2 desktop app that turns natural-language intents into runnable k6 load-test scripts. Vue 3 + TypeScript on the frontend, Rust backend, Monaco editor, pluggable LLM (OpenAI-compatible / Anthropic / Ollama).

## Layout

| Path | What |
|---|---|
| `src/` | Vue 3 frontend (components, pages, stores, lib, composables, i18n, router) |
| `src-tauri/src/` | Rust backend — `main.rs`/`lib.rs`, `k6.rs` runner, `llm.rs` + `llm_stream.rs` providers, `fs.rs` script IO, `settings.rs` persistence, `secrets.rs` OS credential store |
| `src-tauri/binaries/` | k6 sidecar binaries, **gitignored**, fetched per-host via `scripts/fetch-k6.sh` |
| `src-tauri/build.rs` | Exports `PERFPILOT_TARGET_TRIPLE` so Rust resolves the sidecar filename at runtime |
| `e2e/` | Playwright specs — drives Vite dev server with Tauri IPC stubbed via `mock-tauri.ts` |
| `scripts/fetch-k6.sh` | Per-platform k6 fetch (macOS/Linux/Windows) mapped from `rustc -vV` host triple |
| `scripts/build-dmg.sh` | DMG bundling; takes optional target triple as `$1` |
| `.github/workflows/release.yml` | Matrix build (**Windows x64 only** — macOS temporarily disabled, no signing cert) + auto-publishes GitHub Release on tag push |

## Commands

```bash
# Setup (one-time, or after upgrading k6)
npm install
scripts/fetch-k6.sh                       # drops k6 into src-tauri/binaries/

# Development
npm run dev                               # Vite dev server (frontend only)
npm run tauri:dev                         # full desktop app
npm run typecheck                         # vue-tsc --noEmit

# Tests (current counts: 51 cargo, 159 Vitest, 9 Playwright specs)
npm run test                              # Vitest (jsdom)
cd src-tauri && cargo test --lib          # Rust unit tests
npx playwright install chromium          # one-time, before first e2e
npm run test:e2e                          # Playwright (Vite + mocked Tauri IPC)
npm run test:e2e e2e/tests/a11y.spec.ts   # WCAG 2.1 AA scan

# Production
npm run tauri:build                       # .app (macOS) or .exe (Windows)
npm run tauri:build -- --target aarch64-apple-darwin  # explicit triple
npm run tauri:release-dmg                 # macOS .app + .dmg

# Release (publishes via CI)
git tag v0.1.x && git push --tags         # triggers .github/workflows/release.yml
```

## Architecture boundaries

- **Vue → Rust** through Tauri IPC, surfaced to the frontend via `src/lib/`. Don't reach into Rust from components directly.
- **k6 spawning**: `k6::which_k6()` resolution chain — `K6_PATH` (user) → `PERFPILOT_K6_BIN` (sidecar) → common system paths → PATH. `lib::run()` setup() calls `publish_sidecar_path_to_env()` to wire the sidecar path before any test runs.
- **LLM providers**: `LlmProviderConfig` carries the format + model catalog. `llm.rs` is non-streaming; `llm_stream.rs` parses SSE and emits `chunk://` events to the window.
- **State**: Pinia stores under `src/stores/`. Persistence via `@tauri-apps/plugin-store`.
- **i18n**: Vue I18n with English (default) + Chinese (`zh-CN`). Locales in `src/i18n/`.

## Sidecar / cross-platform gotchas

- `bundle.externalBin: ["binaries/k6"]` requires the **source** file to be named `k6-<rustc-target-triple>[.exe]` (Apple Silicon: `k6-aarch64-apple-darwin`; Windows: `k6-x86_64-pc-windows-msvc.exe`; Linux targets are mapped in `scripts/fetch-k6.sh`). Tauri's bundler **strips the target-triple suffix** when placing the binary in the output bundle — the on-disk name in a packaged app is just `k6.exe` (Windows) or `k6` (macOS/Linux). `k6::resolve_sidecar_k6_path()` looks up the stripped name. If you change the source name, update `scripts/fetch-k6.sh`; if you change the bundled name, update `resolve_sidecar_k6_path()`.
- `bundle.targets: "all"` resolves at build time — DMG on macOS, NSIS on Windows, no config change needed.
- `tauri build --target <triple>` puts output under `target/<triple>/release/...`. `build-dmg.sh` accepts the triple as `$1`; the CI workflow passes `${{ matrix.target }}`.
- `mktemp -t PREFIX` is rejected by Windows Git Bash when the prefix has no `X`'s. The release scripts use `mktemp -d` (temp directory) instead — keep them consistent if you copy patterns.
- Don't commit `src-tauri/binaries/*` — gitignored, ~60 MB each, fetched per-host.

## E2E testing strategy (deliberate tradeoff**: don't change without checking with the user)

The Playwright suite drives the Vite dev server, **not the Tauri binary**, and injects `window.__TAURI_INTERNALS__` from `e2e/mock-tauri.ts`. This:

- Iterates in <10 s per spec (vs seconds-per-step for real WebDriver on a Tauri WebView).
- Exercises real Vue/Pinia/router flows end-to-end.
- Sacrifices production parity — bugs that only appear in release builds (Tauri IPC quirks, native dialogs, k6 spawn) are caught by `cargo test` for Rust, and by manual `computer-use` runs against the release DMG before each PR.

When adding IPC commands in Rust, also stub them in `e2e/mock-tauri.ts` — missing stubs throw `not implemented` and break specs that touch the new command.

## Release pipeline (`.github/workflows/release.yml`)

1. Tag push (`v*`) or `workflow_dispatch` triggers `build` matrix.
2. Windows x64 job only (macOS arm64 is **temporarily disabled**, see below): cache cargo → fetch k6 sidecar → `tauri build --target <triple>` → NSIS bundler.
3. Artifacts: `PerfPilot-Windows-x64` (NSIS — 30 MB). `PerfPilot-macOS-arm64` (DMG) is not currently produced.
4. `release` job (Ubuntu, only fires on tag push) downloads artifacts and publishes a GitHub Release via `softprops/action-gh-release@v2`. Re-runs via dispatch do NOT publish.

**macOS builds are temporarily disabled** (no Apple Developer account). An unsigned/un-notarized `.dmg` makes Gatekeeper report「应用已损坏」on launch, so the DMG is unusable for distribution — don't "fix" this by re-adding the macOS matrix entry alone. Restoring it requires uncommenting **both** the `macos-latest` matrix entry **and** the `Download macOS DMG` step + `artifacts/macos/*.dmg` glob in the `release` job; restoring only the first makes the publish job fail on `fail_on_unmatched_files: true`. Local macOS dev builds (`npm run tauri:dev`, `npm run tauri:release-dmg`) are unaffected.

## Things to read before editing

- `src-tauri/src/k6.rs` — k6 runner, metric parser, sidecar resolution. Touching this affects every test run.
- `src-tauri/src/lib.rs` — Tauri command surface (`run_k6`, `generate_script_stream`, etc.). Each new command needs `e2e/mock-tauri.ts` stub.
- `src-tauri/src/secrets.rs` — OS credential store for LLM API keys (`secret_get`/`secret_set`/`secret_delete`).
- `.github/workflows/release.yml` — adding a new platform? Add a `matrix.include` entry + map it in `scripts/fetch-k6.sh`.

## Conventions

- Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `ci:`) — see `git log --oneline`.
- Comments only when they state a constraint the code can't show. No narrating-the-line.
- Frontend state goes in Pinia stores, not in components. Composables (`src/composables/`) for cross-component reactive logic.
- Rust errors returned from `#[tauri::command]` are `Result<T, String>` — stringified for IPC.

## LLM provider API keys live in the OS credential store

Keys are **not** in `perf-pilot.settings.json`. `src-tauri/src/secrets.rs` wraps
`keyring`: macOS Keychain / Windows Credential Manager / Linux Secret Service,
entries namespaced by `SERVICE` and keyed by provider id. The settings JSON keeps
only non-secret config; `llm.ts` strips `api_key` on persist and pulls it back
during `hydrate`, migrating any plaintext key left by an older build.

Gotchas:

- **`keyring` 3.x ships no default features.** Omitting the platform backend makes
  macOS silently fall back to `mock` — an in-memory no-op where every write
  "succeeds" and the key is gone on restart. The backends are re-exported as this
  crate's own `keychain-macos` / `keychain-windows` / `keychain-linux` default
  features in `Cargo.toml` precisely so they can't be dropped by accident.
- **`SERVICE` in `secrets.rs` is hardcoded to `dev.perfpilot.app` and must stay in
  sync with `identifier` in `tauri.conf.json`.** Changing the bundle identifier
  changes where the settings JSON lives but *not* where the keys live, so every
  key silently reads back as empty. There's no API to enumerate keychain entries,
  so the old ones can't be migrated — only re-entered.
- `persist()` syncs secrets **before** writing the JSON, and only strips `api_key`
  for providers whose key is confirmed stored. If the credential store is locked
  or unavailable, the plaintext value stays in the JSON rather than the key being
  destroyed. `llm.secretStoreError` surfaces this in Settings.
- The key still crosses IPC in plaintext on `test_llm` / `generate_script`. This
  closes the *at-rest* exposure only; keeping keys out of renderer memory would
  mean moving provider lookup into Rust.

## Known issues / non-obvious choices

- macOS bundle identifier `dev.perfpilot.app` ends in `.app` — Tauri warns at build time. Not blocking; leave until packaging for the App Store is on the roadmap.
- `npm run build` triggers the frontend typecheck (`vue-tsc --noEmit`) before Vite. CI uses `npm run typecheck` separately for fail-fast on type errors without paying Vite's bundle cost.
- The e2e suite intentionally disables Playwright parallelism — see the comment in `playwright.config.ts`. Don't re-enable without auditing the `installTauriMocks` fixture for shared state.