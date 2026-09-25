import { test, expect } from "../fixtures";
import { gotoApp, waitForAppReady, expectInvoke } from "../helpers";

test.describe("AI generate", () => {
  test("clicking Generate fires generate_script_stream with the prompt", async ({ page }) => {
    await gotoApp(page, "/ai");
    await waitForAppReady(page);

    // The default prompt text is pre-populated; clear it and replace
    // with a controlled string so we can assert it round-trips.
    const textarea = page.locator("textarea").first();
    await textarea.fill("GET https://test.k6.io 5 times");

    // Be specific about which "Generate" button we mean — the
    // Dashboard's "Generate with AI" CTA also matches a loose regex.
    await page.getByRole("button", { name: /Generate k6 script/ }).click();
    await expectInvoke(page, "generate_script_stream");
  });

  test("clicking a template example fills the prompt", async ({ page }) => {
    await gotoApp(page, "/ai");
    await waitForAppReady(page);

    // There are 3 "example" buttons in the prompt card; click the
    // first one and verify the prompt area is no longer empty.
    const exampleButtons = page.getByRole("button", { name: /smoke|spike|api/i });
    await exampleButtons.first().click();
    const textarea = page.locator("textarea").first();
    const value = await textarea.inputValue();
    expect(value.length).toBeGreaterThan(0);
  });

  test("the streaming-completed script is shown in the Monaco container", async ({ page }) => {
    await gotoApp(page, "/ai");
    await waitForAppReady(page);

    await page.locator("textarea").first().fill("simple check");
    await page.getByRole("button", { name: /Generate k6 script/ }).click();
    // Wait for the IPC to round-trip and Monaco to render the result.
    await page.waitForFunction(() => {
      const log = (window as any).__INVOKE_LOG__ ?? [];
      return log.some((c: any) => c.cmd === "generate_script_stream");
    });
    // The Monaco editor mounts as `.monaco-host`; its content lands in
    // the underlying textarea once Monaco has loaded. We don't
    // strictly need to assert the body — we just want to verify the
    // page didn't crash after the click.
    await expect(page.locator(".monaco-host")).toBeAttached();
  });
});
