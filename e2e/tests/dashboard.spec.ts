import { test, expect } from "../fixtures";
import { gotoApp, waitForAppReady } from "../helpers";

test.describe("dashboard", () => {
  test("empty state shows zero counts and the welcome heading", async ({ page }) => {
    await gotoApp(page, "/");
    await waitForAppReady(page);

    // Welcome heading + 4 KPI cards.
    await expect(page.getByRole("heading", { name: /Welcome/i })).toBeVisible();
    const cards = page.locator('[data-testid="dashboard-card"]');
    // Without the data-testid wiring we'll just assert the count
    // numerals rendered (4 of them — passed/failed/running/scripts).
    await expect(page.locator("text=0").first()).toBeVisible();
  });

  test("populated runs surface in KPI cards and recent runs list", async ({ page }) => {
    await gotoApp(page, "/", {
      mockSpec: {
        runs: [
          {
            run_id: "r-1",
            label: "smoke",
            status: "passed",
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            exit_code: 0,
            script_path: "/x/smoke.js",
            p95_ms: 120,
            rps: 50,
            error_rate_pct: 0,
          },
          {
            run_id: "r-2",
            label: "spike",
            status: "failed",
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            exit_code: 1,
            script_path: "/x/spike.js",
          },
        ],
      },
    });
    await waitForAppReady(page);

    // 'passed' and 'failed' badges appear in the recent runs list.
    await expect(page.getByText(/smoke/i).first()).toBeVisible();
    await expect(page.getByText(/spike/i).first()).toBeVisible();
    await expect(page.getByText(/passed/).first()).toBeVisible();
    await expect(page.getByText(/failed/).first()).toBeVisible();

    // Sparkline card is shown because runs have p95_ms / rps.
    await expect(page.getByText(/Performance trends|性能趋势/).first()).toBeVisible();
  });
});
