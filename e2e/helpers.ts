/**
 * Page-object helpers for the e2e suite. Centralises the selectors
 * so tests don't duplicate them, and so a UI tweak doesn't require
 * touching every spec.
 *
 * Routes are matched on `pathname` (the hash-based routes don't
 * apply — vue-router uses history mode here).
 */

import type { Page } from "@playwright/test";

export async function gotoApp(
  page: Page,
  path = "/",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockSpecOrWrapper: any = undefined,
): Promise<void> {
  // Accept either a bare spec object or a `{ mockSpec: {...} }`
  // wrapper — both shapes appear in the codebase.
  const mockSpec =
    mockSpecOrWrapper && typeof mockSpecOrWrapper === "object" && "mockSpec" in mockSpecOrWrapper
      ? mockSpecOrWrapper.mockSpec
      : mockSpecOrWrapper;

  if (mockSpec) {
    const { installTauriMocks } = await import("./mock-tauri");
    await installTauriMocks(page, mockSpec);
  }
  const target = new URL(path, "http://localhost:1420").pathname;

  // First load: let Vite serve index.html so the SPA shell mounts.
  // The router will land on `/` (hash mode + redirect chain), then
  // we explicitly click the matching nav button to land on the
  // requested route. page.goto alone isn't enough because vue-router
  // hash mode initialises from `window.location.hash`, which is
  // empty after a fresh navigation.
  await page.goto(target, { waitUntil: "domcontentloaded" });
  await page.waitForURL((u) => u.pathname === target, { timeout: 5_000 }).catch(() => {});

  // Force-navigate via the nav button. Mapping of pathname → label.
  const navMap: Record<string, RegExp> = {
    "/": /Dashboard/,
    "/dashboard": /Dashboard/,
    "/editor": /Script Editor|Editor/,
    "/ai": /AI Generate/,
    "/runs": /Live Runs|Runs/,
    "/history": /History/,
    "/settings": /LLM Settings|Settings/,
  };
  const navLabel = navMap[target];
  if (navLabel && target !== "/") {
    // Click only if we aren't already on the right page (check via
    // window.location — page.url() reflects the address bar, not
    // the hash-based router location).
    const onRightRoute = await page.evaluate((p) => {
      const hash = window.location.hash.replace(/^#/, "");
      const path = hash.split("?")[0] || "/";
      return path === p;
    }, target);
    if (!onRightRoute) {
      await page.getByRole("button", { name: navLabel }).first().click();
      await page.waitForFunction(
        (p) => {
          const hash = window.location.hash.replace(/^#/, "");
          return (hash.split("?")[0] || "/") === p;
        },
        target,
        { timeout: 5_000 },
      );
    }
  }
}

/**
 * Backwards-compatible alias for tests written against the
 * `gotoAppWithMock(page, path, mockSpec)` shape.
 */
export async function gotoAppWithMock(
  page: Page,
  path: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockSpec: any,
): Promise<void> {
  return gotoApp(page, path, mockSpec);
}

export async function clickNav(page: Page, label: RegExp | string): Promise<void> {
  const target =
    typeof label === "string" ? page.getByRole("link", { name: label }) : page.getByRole("link", { name: label });
  await target.first().click();
}

/** Wait until the dev server's app shell has hydrated and the
 *  sidebar nav is visible — the cheapest "we're past the boot"
 *  signal we have without coupling to internal store state. */
export async function waitForAppReady(
  page: Page,
  /** Optional path the route should land on. When set, the helper
   *  waits until `window.location.pathname` matches. Useful for
   *  tests that drive routes via `gotoApp(page, "/ai")` — the SPA
   *  fallback returns `index.html` for every path, so the URL
   *  update only happens once vue-router boots. */
  expectedPath?: string,
): Promise<void> {
  await page.locator("aside nav button").first().waitFor({ state: "visible" });
  if (expectedPath) {
    await page
      .waitForFunction(
        (p) => window.location.pathname === p,
        expectedPath,
        { timeout: 5_000 },
      )
      .catch(() => {
        // Best effort — the test that called `gotoApp("/ai")` will
        // usually trigger an explicit `waitForURL` if it cares.
      });
  }
  // Wait one more tick so vue-router finishes its initial resolution
  // and the right-side pane (route content) actually mounts.
  await page.waitForTimeout(150);
}

/** Helper for the "did the IPC command fire?" assertion. Reads the
 *  recorded call log from the page and finds the call by name. */
export async function expectInvoke(
  page: Page,
  cmd: string | RegExp,
  options: { timeout?: number } = {},
): Promise<void> {
  const timeout = options.timeout ?? 5_000;
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const log = await page.evaluate(() => (window as any).__INVOKE_LOG__ ?? []);
    const hit =
      typeof cmd === "string"
        ? log.find((c: { cmd: string }) => c.cmd === cmd)
        : log.find((c: { cmd: string }) => cmd.test(c.cmd));
    if (hit) return;
    if (Date.now() - start > timeout) {
      throw new Error(
        `expectInvoke: ${cmd} did not fire within ${timeout}ms (saw ${log.length} calls: ${log
          .slice(-5)
          .map((c: { cmd: string }) => c.cmd)
          .join(", ")})`,
      );
    }
    await page.waitForTimeout(50);
  }
}
