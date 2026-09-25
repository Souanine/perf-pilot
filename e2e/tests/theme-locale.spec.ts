import { test, expect } from "../fixtures";
import { gotoApp, waitForAppReady } from "../helpers";

test.describe("theme + locale", () => {
  test("toggle theme switches the <html> dark class", async ({ page }) => {
    await gotoApp(page, "/");
    await waitForAppReady(page);

    const html = page.locator("html");
    // Start in light by default (mock default — no localStorage set).
    // After clicking the theme toggle, dark class is added/removed.
    const wasDark = await html.evaluate((el) => el.classList.contains("dark"));
    await page.getByRole("button", { name: /Toggle theme/i }).click();
    const nowDark = await html.evaluate((el) => el.classList.contains("dark"));
    expect(nowDark).toBe(!wasDark);
  });

  test("locale selector switches between English and Chinese", async ({ page }) => {
    await gotoApp(page, "/");
    await waitForAppReady(page);

    // Default is English ("Welcome" is the en heading).
    await expect(page.getByRole("heading", { name: /Welcome/i })).toBeVisible();

    // Switch to Chinese — the heading changes to "欢迎使用 PerfPilot".
    const select = page.locator('select[aria-label*="language" i]');
    await select.selectOption({ label: "中文" });
    await expect(page.getByRole("heading", { name: /欢迎使用 PerfPilot/ })).toBeVisible();
  });
});
