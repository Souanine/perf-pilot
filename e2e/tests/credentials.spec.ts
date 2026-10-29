import { test, expect } from "../fixtures";
import { gotoApp, waitForAppReady, expectInvoke } from "../helpers";

/** Read the recorded invoke log and return the args of the last call
 *  matching `cmd`, or undefined. */
async function lastInvokeArgs(page: import("@playwright/test").Page, cmd: string) {
  return page.evaluate((c) => {
    const log = (window as any).__INVOKE_LOG__ ?? [];
    for (let i = log.length - 1; i >= 0; i--) {
      if (log[i].cmd === c) return log[i].args;
    }
    return undefined;
  }, cmd);
}

test.describe("credentials page", () => {
  test("empty state renders", async ({ page }) => {
    await gotoApp(page, "/credentials");
    await waitForAppReady(page);
    await expect(page.getByText(/No credentials yet|暂无凭据/).first()).toBeVisible();
  });

  test("adding a token credential writes values to the vault, not the settings JSON", async ({ page }) => {
    await gotoApp(page, "/credentials");
    await waitForAppReady(page);

    await page.getByTestId("cred-add").click();
    await page.getByTestId("cred-name").fill("Staging token");
    await page.getByTestId("cred-envkey").fill("AUTH_TOKEN");
    await page.getByTestId("cred-values").fill("tok-alpha\ntok-beta");
    await page.getByTestId("cred-save").click();

    // The credential shows up in the list with its pool size.
    await expect(page.getByText("Staging token").first()).toBeVisible();
    await expect(page.getByText(/2 stored|已存 2/).first()).toBeVisible();

    // Values landed in the vault (one entry per pool value), keyed by id.
    const setArgs = await lastInvokeArgs(page, "credential_set_values");
    expect(setArgs).toBeTruthy();
    expect(setArgs.values).toEqual(["tok-alpha", "tok-beta"]);
    const stored = await page.evaluate(
      (id) => Array.from((window as any).__CRED_STORE__.entries()).filter(([k]) => k.startsWith(`cred:${id}:`)),
      setArgs.id,
    );
    expect(stored).toHaveLength(2);

    // The settings JSON write must carry metadata only — never the values.
    const persisted = await page.evaluate(() => {
      const log = (window as any).__INVOKE_LOG__ ?? [];
      const hit = log.filter(
        (c: any) => c.cmd === "plugin:store|set" && c.args?.key === "credentials.list",
      );
      return hit.length ? JSON.stringify(hit[hit.length - 1].args.value) : "";
    });
    expect(persisted).toContain("Staging token");
    expect(persisted).not.toContain("tok-alpha");
  });

  test("importing pasted .env content creates credentials", async ({ page }) => {
    await gotoApp(page, "/credentials");
    await waitForAppReady(page);

    await page.getByTestId("cred-import").click();
    await page.getByTestId("cred-import-text").fill("TOKEN=abc123\nAPI_KEY=sk-x");
    await expect(page.getByText(/2 credential|已解析 2/).first()).toBeVisible();
    await page.getByTestId("cred-import-confirm").click();

    await expect(page.getByText("TOKEN").first()).toBeVisible();
    await expect(page.getByText("API_KEY").first()).toBeVisible();
  });

  test("selected credentials are passed to run_k6 as ids only", async ({ page }) => {
    await gotoApp(page, "/credentials", {
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

    // Create a credential on the credentials page (SPA nav keeps the store).
    await page.getByTestId("cred-add").click();
    await page.getByTestId("cred-name").fill("Run token");
    await page.getByTestId("cred-values").fill("super-secret-value");
    await page.getByTestId("cred-save").click();
    const setArgs = await lastInvokeArgs(page, "credential_set_values");
    const credId: string = setArgs.id;

    // Same page session: jump to the runs page.
    await page.getByRole("button", { name: /Live Runs|实时运行/ }).first().click();
    await page.waitForFunction(() => {
      const hash = window.location.hash.replace(/^#/, "");
      return (hash.split("?")[0] || "/") === "/runs";
    });
    await waitForAppReady(page);

    // The credential appears in the run panel; tick it.
    const checkbox = page.getByTestId(`run-cred-${credId}`).locator("input[type=checkbox]");
    await expect(checkbox).toBeVisible();
    await checkbox.check();

    await page.locator("main select").first().selectOption({ label: "smoke.js" });
    await page.getByRole("button", { name: /Start run|^Start$/i }).first().click();
    await expectInvoke(page, "run_k6");

    // run_k6 received the credential id — and no secret anywhere in options.
    const runArgs = await lastInvokeArgs(page, "run_k6");
    expect(runArgs.options.credentials).toEqual([credId]);
    expect(JSON.stringify(runArgs.options)).not.toContain("super-secret-value");
  });
});
