import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the e2e suite.
 *
 * Strategy:
 *   - Drive the Vite dev server (port 1420, the same one `tauri dev`
 *     would talk to). Production parity is sacrificed for iteration
 *     speed — if a bug only shows up in release builds we still have
 *     `cargo test` for the Rust side.
 *   - Stub Tauri IPC by injecting `window.__TAURI_INTERNALS__` from
 *     `e2e/mock-tauri.ts`. This exercises the real Vue/Pinia/router
 *     stack end-to-end without needing the desktop binary, the
 *     WebDriver harness, or a running Rust backend.
 *   - Run headless on chromium for speed. Local dev can flip to
 *     headed via `npx playwright test --headed`.
 */
export default defineConfig({
  testDir: "./e2e/tests",
  // Parallelism is disabled for now: the installTauriMocks fixture adds
  // init scripts to the page, and re-installing on top of a previous
  // install (via gotoAppWithMock) leaves residual handler maps that
  // bleed between tests. Run sequentially for stability; revisit when
  // we move the mock to a per-context service.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 30_000,
  expect: { timeout: 5_000 },

  use: {
    baseURL: "http://localhost:1420",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    // `vite` reads its config from `vite.config.ts`. The dev server
    // honours `VITE_` env vars, which is how the IPC stub on the
    // page side knows it's running under test.
    command: "npm run dev -- --mode test",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
