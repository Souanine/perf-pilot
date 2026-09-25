import { test, expect } from "../fixtures";
import { gotoApp, waitForAppReady } from "../helpers";

test.describe("history page", () => {
  test("empty state shows the 'no match' placeholder when there are no runs", async ({ page }) => {
    await gotoApp(page, "/history");
    await waitForAppReady(page);
    // No matches — runs.history is empty.
    await expect(page.getByText(/No runs match|No runs/i).first()).toBeVisible();
  });

  test("populated state renders the run list and lets you click a row", async ({ page }) => {
    await gotoApp(page, "/history", {
      mockSpec: {
        runs: [
          {
            run_id: "r-1",
            label: "baseline",
            status: "passed",
            started_at: new Date(Date.now() - 60_000).toISOString(),
            finished_at: new Date().toISOString(),
            exit_code: 0,
            script_path: "/x/baseline.js",
          },
          {
            run_id: "r-2",
            label: "spike",
            status: "failed",
            started_at: new Date(Date.now() - 30_000).toISOString(),
            finished_at: new Date().toISOString(),
            exit_code: 1,
            script_path: "/x/spike.js",
          },
        ],
      },
    });
    await waitForAppReady(page);

    await expect(page.getByText(/baseline/i).first()).toBeVisible();
    await expect(page.getByText(/spike/i).first()).toBeVisible();

    // Clicking a row populates the detail panel. (The source only
    // wires query → state one-way; we assert the rendered detail
    // directly rather than the URL.)
    await page.getByText(/spike/i).first().click();
    // The detail panel renders a "Script:" card and a "script" badge.
    await expect(page.getByText(/spike/i).first()).toBeVisible();
    // Wait for the detail header to switch from the placeholder:
    // when a row is selected, the right pane shows the run id.
    await expect(
      page.locator(".text-muted-foreground").filter({ hasText: /id r-2/ }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("filter narrows the visible rows", async ({ page }) => {
    await gotoApp(page, "/history", {
      mockSpec: {
        runs: [
          { run_id: "r-1", label: "baseline", status: "passed", started_at: new Date().toISOString(), finished_at: null, exit_code: null, script_path: "/x/a.js" },
          { run_id: "r-2", label: "spike", status: "failed", started_at: new Date().toISOString(), finished_at: null, exit_code: null, script_path: "/x/b.js" },
        ],
      },
    });
    await waitForAppReady(page);

    await page.getByPlaceholder(/Search runs/i).fill("spike");
    // Only spike should remain visible; baseline should not.
    await expect(page.getByText(/^spike$/).first()).toBeVisible();
    await expect(page.getByText(/^baseline$/)).toHaveCount(0);
  });
});
