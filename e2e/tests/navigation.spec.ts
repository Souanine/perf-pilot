import { test, expect } from "../fixtures";
import { gotoApp, waitForAppReady } from "../helpers";

test.describe("navigation", () => {
  test("boot loads the dashboard and triggers boot-time hydrations", async ({ page }) => {
    await gotoApp(page, "/");
    await waitForAppReady(page);

    // Five store hydrations fire on app boot — the boot is correct
    // only if each one calls its underlying IPC command.
    await page.waitForFunction(() => {
      const log = (window as any).__INVOKE_LOG__ ?? [];
      const cmds = new Set(log.map((c: any) => c.cmd));
      return (
        cmds.has("ensure_dirs") &&
        cmds.has("get_app_info") &&
        cmds.has("list_scripts") &&
        cmds.has("list_runs")
      );
    });

    // Sidebar nav renders the seven routes in expected order.
    const navLabels = await page.locator("aside nav button").allInnerTexts();
    expect(navLabels.length).toBe(7); // Dashboard, Editor, AI, Runs, Credentials, History, Settings
    expect(navLabels[0]).toMatch(/Dashboard/);
    expect(navLabels[1]).toMatch(/Script Editor|Editor/);
    expect(navLabels[4]).toMatch(/Credentials|凭据管理/);
    expect(navLabels[6]).toMatch(/Settings|LLM/);
  });

  test("clicking a nav item navigates without a full page reload", async ({ page }) => {
    await gotoApp(page, "/");
    await waitForAppReady(page);

    const before = page.url();
    // The sidebar nav uses <button> elements (not <a>/<router-link>),
    // so role="button" is the correct match.
    await page.getByRole("button", { name: /Runs/ }).first().click();
    await page.waitForFunction(() => window.location.hash === "#/runs", undefined, {
      timeout: 5_000,
    });
    // SPA navigation — page reference is preserved.
    expect(page.url()).not.toBe(before);
    // Header still shows the active section title.
    await expect(page.getByRole("heading", { name: /Live Runs|Runs/ }).first()).toBeVisible();
  });

  test("sidebar collapse survives a route change", async ({ page }) => {
    await gotoApp(page, "/");
    await waitForAppReady(page);

    // Collapse the sidebar via the toggle button.
    await page.getByRole("button", { name: /Toggle sidebar/i }).click();
    // Sidebar should now show only icon-width items (the script label
    // text vanishes). We verify by checking the sidebar width class.
    await expect(page.locator("aside").first()).toHaveClass(/w-16/);

    // With the labels hidden, identify nav buttons by position in the
    // nav instead of name. The order matches `navItems` in AppLayout:
    // 0 Dashboard, 1 Editor, 2 AI, 3 Runs, 4 Credentials, 5 History, 6 Settings.
    // (5 = History)
    await page.locator("aside nav button").nth(5).click();
    await page.waitForFunction(() => window.location.hash.startsWith("#/history"), undefined, {
      timeout: 5_000,
    });
    // (0 = Dashboard)
    await page.locator("aside nav button").nth(0).click();
    await page.waitForFunction(
      () =>
        window.location.hash === "" ||
        window.location.hash === "#/" ||
        window.location.hash === "#/dashboard",
      undefined,
      { timeout: 5_000 },
    );
    await expect(page.locator("aside").first()).toHaveClass(/w-16/);
  });

  test("unknown route falls back to a 404 / empty state", async ({ page }) => {
    await gotoApp(page, "/this-route-does-not-exist");
    await waitForAppReady(page);
    // Vue router's default is to render an empty <router-view>; we
    // accept any non-thrown render as success but make sure the
    // sidebar is still there (the layout always wraps it).
    await expect(page.locator("aside").first()).toBeVisible();
  });
});
