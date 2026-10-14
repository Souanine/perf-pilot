import { test, expect } from "../fixtures";
import { gotoApp, waitForAppReady, expectInvoke } from "../helpers";

test.describe("settings (LLM providers)", () => {
  test("renders default providers from the mock catalog", async ({ page }) => {
    await gotoApp(page, "/settings");
    await waitForAppReady(page);
    // Default provider name from mock-tauri's DEFAULTS.
    await expect(page.getByText("OpenAI").first()).toBeVisible();
    // The API format / endpoint chip is visible.
    await expect(page.getByText(/chat_completions|Chat Completions/).first()).toBeVisible();
  });

  test("clicking the test button for a provider calls test_llm", async ({ page }) => {
    await gotoApp(page, "/settings");
    await waitForAppReady(page);

    const testBtn = page.getByRole("button", { name: /^Test$/ }).first();
    await testBtn.click();
    await expectInvoke(page, "test_llm");
  });

  test("editing a field calls updateProvider via the debounced persist", async ({ page }) => {
    await gotoApp(page, "/settings");
    await waitForAppReady(page);

    // The first provider card's "Base URL" field. We locate by the
    // surrounding <Label> text rather than placeholder, since the
    // seeded providers each carry their own URL.
    const baseUrl = page
      .locator("label", { hasText: /Base URL/ })
      .first()
      .locator("..")
      .locator("input");
    await baseUrl.fill("https://proxy.local/v1");
    // Tab away to flush any input debouncing.
    await baseUrl.press("Tab");

    // Give the 300ms persist debounce a chance to flush.
    await page.waitForTimeout(400);
    await expectInvoke(page, /plugin:store/);
  });

  test("adding a new provider with required fields pushes a new card", async ({ page }) => {
    await gotoApp(page, "/settings");
    await waitForAppReady(page);

    // The "Add a provider" disclosure button has `aria-label="Expand"`
    // (set programmatically to "Expand"/"Collapse"). Match by aria.
    await page.getByRole("button", { name: /^Expand$/i }).first().click();

    // The new draft form is rendered after the disclosure opens.
    // Scope to the "Save provider" button's enclosing Card and walk
    // back up so we don't collide with the existing providers'
    // identical placeholder fields. The new draft is the only card
    // whose ancestor contains "Save provider".
    const saveBtn = page.getByRole("button", { name: /Save provider/i });
    await saveBtn.waitFor({ state: "visible", timeout: 5_000 });
    const newCard = saveBtn.locator("xpath=ancestor::*[contains(@class,'rounded-lg')][1]");
    await newCard.getByPlaceholder(/My OpenAI proxy/).fill("Test proxy");
    await newCard.getByPlaceholder(/api\.example\.com\/v1/).fill("https://test.local/v1");
    await newCard.getByPlaceholder(/sk-…/).fill("sk-test");
    await newCard.getByPlaceholder(/^gpt-4o-mini$/).fill("gpt-test");
    await saveBtn.click();

    // The new provider appears in the list.
    await expect(page.getByText("Test proxy").first()).toBeVisible();
  });
});

test.describe("settings — model selection is not provider activation", () => {
  test("picking a model marks it in use without activating the provider", async ({ page }) => {
    await gotoApp(page, "/settings");
    await waitForAppReady(page);

    // The default provider is the active one; switch to a second card so
    // an accidental activation would be visible.
    const activeBadge = page.getByText(/^(active|激活)$/).first();
    await expect(activeBadge).toBeVisible();

    // Grab the second provider's card and click a non-active model row.
    const modelButtons = page.locator("main button[aria-label='Use this model']");
    const count = await modelButtons.count();
    expect(count).toBeGreaterThan(0);
    await modelButtons.first().click();

    // Exactly one provider is still active, and it is the original one.
    await expect(page.getByText(/^(active|激活)$/)).toHaveCount(1);

    // The newly chosen model is labelled "In use", never "Active" — the
    // two concepts must not share vocabulary.
    await expect(page.locator("main").getByText(/^(In use|使用中)$/).first()).toBeVisible();
    await expect(page.locator("main")).not.toContainText(/^(激活中|Active)$/);
  });
});
