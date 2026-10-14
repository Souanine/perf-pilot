import { test, expect } from "../fixtures";
import { gotoApp, waitForAppReady } from "../helpers";

/**
 * The Live Runs page is for in-flight work only. Finished runs — and the
 * detail pane they used to pull up, with Export / Delete / Generate report
 * — belong to the History page, which already renders all of that.
 *
 * Regression guard: the rail used to iterate `runs.liveList` (everything
 * `list_runs` returned) and `selectedRun` fell back to it, so clicking a
 * run from last week swapped the whole main pane over to a "RUN HISTORY"
 * detail view. The two history pages then showed the same rows doing the
 * same things.
 *
 * NOTE ON COVERAGE: this suite stubs Tauri IPC, so `run_k6` resolves to
 * canned data and k6 is never spawned. Nothing here can catch a broken
 * k6 invocation — `runs.spec.ts` asserts only that the IPC was *called*.
 * The real argument vector is covered on the Rust side in k6.rs
 * (`build_k6_args_*`).
 */

const THREE_SCRIPTS = [
  { path: "/app/scripts/first-load.js", name: "first-load.js", size: 900, modified_at: "2026-10-01T10:00:00Z" },
  { path: "/app/scripts/checkout-smoke.js", name: "checkout-smoke.js", size: 1200, modified_at: "2026-10-05T10:00:00Z" },
  { path: "/app/scripts/abandoned-experiment.js", name: "abandoned-experiment.js", size: 400, modified_at: "2026-09-20T10:00:00Z" },
];

const PAST_RUNS = [
  {
    run_id: "run-001",
    label: "checkout-smoke",
    status: "passed",
    started_at: "2026-10-05T10:00:00Z",
    finished_at: "2026-10-05T10:02:00Z",
    exit_code: 0,
    script_path: "/app/scripts/checkout-smoke.js",
  },
  {
    run_id: "run-002",
    label: "abandoned-experiment",
    status: "failed",
    started_at: "2026-10-06T11:00:00Z",
    finished_at: "2026-10-06T11:01:00Z",
    exit_code: 107,
    script_path: "/app/scripts/abandoned-experiment.js",
  },
];

test.describe("runs page — history is not selectable here", () => {
  test("completed runs do not appear in the running rail", async ({ page }) => {
    await gotoApp(page, "/runs", {
      mockSpec: { scripts: THREE_SCRIPTS, runs: PAST_RUNS },
    });
    await waitForAppReady(page);

    // The app shell nav is also an <aside>; scope to the one holding the
    // new-run form, identified by its label placeholder.
    const rail = page.locator("aside").filter({
      has: page.getByPlaceholder(/checkout-smoke/),
    });
    await expect(rail).toContainText(/Running now|实时运行/);

    // Neither finished run may be offered for selection.
    await expect(rail.getByRole("button").filter({ hasText: "checkout-smoke" })).toHaveCount(0);
    await expect(rail.getByRole("button").filter({ hasText: "abandoned-experiment" })).toHaveCount(0);
  });

  test("the main pane stays on the 'pick a script' placeholder", async ({ page }) => {
    await gotoApp(page, "/runs", {
      mockSpec: { scripts: THREE_SCRIPTS, runs: PAST_RUNS },
    });
    await waitForAppReady(page);

    // Previously a completed run auto-selected and the pane title became
    // "RUN HISTORY" with Export / Delete / Generate report controls.
    await expect(page.locator("main")).toContainText(/Pick a script and start a run|选择脚本/);
    await expect(page.locator("main")).not.toContainText(/RUN HISTORY|Generate report|Export/);
  });

  test("a run started in this session appears and stays selectable", async ({ page }) => {
    await gotoApp(page, "/runs", { mockSpec: { scripts: THREE_SCRIPTS } });
    await waitForAppReady(page);

    const rail = page.locator("aside").filter({
      has: page.getByPlaceholder(/checkout-smoke/),
    });

    // `live` is populated by `start()`, not by `list_runs` — a run that
    // was already going when the app opened is not "live" to this
    // session, so the only way to get a row here is to launch one.
    await page.locator("main select").first().selectOption({ label: "first-load.js" });
    await page.getByPlaceholder(/checkout-smoke/).fill("in-flight");
    await page.getByRole("button", { name: /Start run|^Start$/i }).first().click();

    const row = rail.getByRole("button").filter({ hasText: "in-flight" });
    await expect(row).toHaveCount(1);

    await row.first().click();
    await expect(page.locator("main")).toContainText("in-flight");
  });

  test("the script picker still lists saved scripts", async ({ page }) => {
    await gotoApp(page, "/runs", { mockSpec: { scripts: THREE_SCRIPTS } });
    await waitForAppReady(page);

    const options = await page.locator("main select").first().locator("option").allTextContents();
    expect(options).toEqual([
      "— pick a script —",
      "first-load.js",
      "checkout-smoke.js",
      "abandoned-experiment.js",
    ]);
  });

  test("Start Run sends the selected script path to run_k6", async ({ page }) => {
    await gotoApp(page, "/runs", { mockSpec: { scripts: THREE_SCRIPTS } });
    await waitForAppReady(page);

    await page.locator("main select").first().selectOption({ label: "first-load.js" });
    await page.getByPlaceholder(/checkout-smoke/).fill("ui-test");
    await page.getByRole("button", { name: /Start run|^Start$/i }).first().click();

    const call = await page.evaluate(async () => {
      const log = (window as any).__INVOKE_LOG__ as any[];
      return log.find((e) => e.cmd === "run_k6") ?? null;
    });
    expect(call).not.toBeNull();
    expect(call.args.scriptPath).toBe("/app/scripts/first-load.js");
  });
});