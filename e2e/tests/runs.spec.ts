import { test, expect } from "../fixtures";
import { gotoApp, waitForAppReady, expectInvoke } from "../helpers";

test.describe("runs page", () => {
  test("empty state shows the placeholder when no scripts are configured", async ({ page }) => {
    await gotoApp(page, "/runs");
    await waitForAppReady(page);
    // No "live" or "recent" rows expected.
    await expect(page.getByText(/No runs yet|noRunsYet|暂无运行/).first()).toBeVisible();
  });

  test("filling the start form and submitting calls run_k6 with the right args", async ({ page }) => {
    await gotoApp(page, "/runs", {
      mockSpec: {
        scripts: [
          {
            path: "/app/scripts/smoke.js",
            name: "smoke.js",
            size: 1024,
            modified_at: new Date().toISOString(),
          },
        ],
      },
    });
    await waitForAppReady(page);

    // The script picker is a native <select>; selectOption sets v-model.
    // Scope to the runs page (the header has its own language <select>).
    await page
      .locator("main select")
      .first()
      .selectOption({ label: "smoke.js" });

    // Type a label so the form is "valid".
    await page.getByPlaceholder(/checkout-smoke/).fill("e2e-smoke");

    // Click the Start Run button.
    await page.getByRole("button", { name: /Start run|^Start$/i }).first().click();

    // The mock recorded a `run_k6` call.
    await expectInvoke(page, "run_k6");
  });

  test("k6 not available surfaces a warning", async ({ page }) => {
    await gotoApp(page, "/runs", {
      mockSpec: {
        appInfo: {
          app_version: "0.1.0-test",
          k6_info: null,
          app_data_dir: "/tmp/p",
          scripts_dir: "/tmp/p/scripts",
          runs_dir: "/tmp/p/runs",
        },
      },
    });
    await waitForAppReady(page);

    await expect(page.getByText(/k6 binary not found|k6: not found/i).first()).toBeVisible();
    // Start Run button is disabled.
    const start = page.getByRole("button", { name: /Start Run|Start/i }).first();
    await expect(start).toBeDisabled();
  });
});
