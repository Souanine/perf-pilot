// Stub the Tauri IPC so stores can be unit-tested without an actual Tauri runtime.
// We import the *real* stub from a tiny test-only shim so the Tauri API stays
// decoupled from the stores under test.
import { vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
  })),
}));