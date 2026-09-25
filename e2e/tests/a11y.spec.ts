/**
 * Accessibility scans with axe-core.
 *
 * These run the WCAG 2.1 AA rule set against every page so we catch
 * regressions in landmark roles, form labelling, colour contrast,
 * focus order, etc. The test tag is intentionally narrow — we
 * assert that there are zero "serious" or "critical" violations; we
 * don't gate on minor or moderate so a low-priority finding doesn't
 * fail CI. Run `npx playwright test e2e/tests/a11y.spec.ts` to
 * regenerate after a UI change; the report shows which rule tripped.
 *
 * Run with the standard `npm run test:e2e` invocation; axe scans
 * add ~200ms per route, so the suite stays under a minute total.
 */
import { test, expect } from "../fixtures";
import AxeBuilder from "@axe-core/playwright";
import { gotoApp, waitForAppReady } from "../helpers";

/** Routes we want to audit. Each one runs in its own test so a
 *  violation on one page doesn't bury the others. */
const routes: { path: string; label: string }[] = [
  { path: "/", label: "Dashboard" },
  { path: "/editor", label: "Script Editor" },
  { path: "/ai", label: "AI Generate" },
  { path: "/runs", label: "Live Runs" },
  { path: "/history", label: "History" },
  { path: "/settings", label: "LLM Settings" },
];

const SEVERITIES_THAT_FAIL = ["serious", "critical"] as const;

for (const { path, label } of routes) {
  test(`a11y: ${label} (${path}) has no serious/critical violations`, async ({
    page,
  }) => {
    await gotoApp(page, path);
    await waitForAppReady(page);

    // Wait one tick so any deferred UI (e.g. sparklines mounted via
    // watchEffect) is fully painted before axe walks the DOM.
    await page.waitForTimeout(200);

    const results = await new AxeBuilder({ page })
      // WCAG 2.0 + 2.1 AA — the practical standard for desktop apps.
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    const blocking = results.violations.filter((v) =>
      SEVERITIES_THAT_FAIL.includes(
        v.impact as (typeof SEVERITIES_THAT_FAIL)[number],
      ),
    );
    if (blocking.length > 0) {
      // Print a compact summary so the failure output is actionable.
      const summary = blocking
        .map(
          (v) =>
            `[${v.impact}] ${v.id}: ${v.help}` +
            (v.nodes.length
              ? ` (${v.nodes.length} node${v.nodes.length === 1 ? "" : "s"}: ${v.nodes
                  .map((n) => n.target.join(" "))
                  .slice(0, 3)
                  .join(", ")}…)`
              : ""),
        )
        .join("\n");
      throw new Error(`${label} (${path}) failed axe:\n${summary}`);
    }

    // Soft-assert: surface the count of minor/moderate findings
    // without failing the test. Useful as a signal in the report.
    const advisory = results.violations.filter(
      (v) =>
        !SEVERITIES_THAT_FAIL.includes(
          v.impact as (typeof SEVERITIES_THAT_FAIL)[number],
        ),
    );
    expect.soft(advisory.length, `${label} advisory findings`).toBeLessThan(20);
  });
}
