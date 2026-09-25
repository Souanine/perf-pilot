/**
 * Playwright fixtures for the e2e suite.
 *
 * Extends the base `test` with:
 *   - `page`: auto-installs the Tauri shim before navigating, so the
 *     Vue app boots against a fully mocked IPC layer.
 *   - `mockSpec`: lets each test describe its own seed data (scripts,
 *     runs, LLM providers, etc).
 *
 * Tests that need direct access to the mock state can call
 * `readInvokeLog(testInfo.page)` from `mock-tauri.ts`.
 */

import { test as base } from "@playwright/test";
import {
  installTauriMocks,
  type MockSpec,
  readInvokeLog,
  waitForInvoke,
  type InvokeCall,
} from "./mock-tauri";

type Worker = typeof base;

export const test = base.extend<{
  /** Per-test mock data. Anything not specified falls back to
   *  `mock-tauri.ts`'s `DEFAULTS`. */
  mockSpec: MockSpec;
}>({
  mockSpec: [{}, { option: true }],

  page: async ({ page, mockSpec }, use) => {
    await installTauriMocks(page, mockSpec);
    await use(page);
  },
});

export { expect } from "@playwright/test";
export { readInvokeLog, waitForInvoke };
export type { InvokeCall, MockSpec };
