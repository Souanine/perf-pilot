import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { setActivePinia, createPinia } from "pinia";

// Mock the Tauri IPC module so the store doesn't talk to a real backend.
vi.mock("@/lib/tauri", async () => {
  const FAKE_SCRIPT = { path: "/x/a.js", name: "a.js", size: 10, modified_at: "2026-01-01T00:00:00Z" };
  return {
    api: {
      listScripts: vi.fn(async () => [FAKE_SCRIPT]),
      readScript: vi.fn(async (p: string) => `// ${p}\n`),
      writeScript: vi.fn(async () => undefined),
      deleteScript: vi.fn(async () => undefined),
    },
  };
});

import { useScriptsStore } from "@/stores/scripts";
import { api } from "@/lib/tauri";

describe("scripts store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("refresh fetches and populates files", async () => {
    const s = useScriptsStore();
    await s.refresh();
    expect(s.files.length).toBe(1);
    expect(s.files[0].name).toBe("a.js");
  });

  it("updateContent mutates the buffer and marks it dirty", async () => {
    const s = useScriptsStore();
    await s.open("/x/a.js");
    expect(s.buffers[0].dirty).toBe(false);
    s.updateContent("/x/a.js", "// edited\n");
    expect(s.buffers[0].content).toBe("// edited\n");
    expect(s.buffers[0].dirty).toBe(true);
    // Setting the same value keeps dirty true (we don't bother to dedupe).
    s.updateContent("/x/a.js", "// edited\n");
    expect(s.buffers[0].dirty).toBe(true);
  });

  it("setActive switches activePath when buffer exists, ignores unknown", async () => {
    const s = useScriptsStore();
    await s.open("/x/a.js");
    await s.open("/x/b.js");
    expect(s.activePath).toBe("/x/b.js");
    s.setActive("/x/a.js");
    expect(s.activePath).toBe("/x/a.js");
    s.setActive("/x/missing.js");
    expect(s.activePath).toBe("/x/a.js");
  });

  it("closeBuffer drops the buffer; activePath falls back to the first remaining", async () => {
    const s = useScriptsStore();
    await s.open("/x/a.js");
    await s.open("/x/b.js");
    s.closeBuffer("/x/b.js");
    expect(s.buffers.length).toBe(1);
    expect(s.activePath).toBe("/x/a.js");
  });

  it("save writes to disk and clears the dirty flag", async () => {
    const s = useScriptsStore();
    await s.open("/x/a.js");
    s.updateContent("/x/a.js", "// edited\n");
    await s.save("/x/a.js");
    expect(api.writeScript as unknown as Mock).toHaveBeenCalledWith("/x/a.js", "// edited\n");
    expect(s.buffers[0].dirty).toBe(false);
  });

  it("saveAs opens a buffer for the new path with the given content", async () => {
    const s = useScriptsStore();
    await s.saveAs("/x/new.js", "// fresh\n");
    expect(s.buffers.length).toBe(1);
    expect(s.buffers[0].content).toBe("// fresh\n");
    expect(s.buffers[0].dirty).toBe(false);
    expect(s.activePath).toBe("/x/new.js");
  });

  it("save patches the file list without a refresh round-trip", async () => {
    const s = useScriptsStore();
    await s.refresh();
    const listBefore = (api.listScripts as unknown as Mock).mock.calls.length;
    await s.open("/x/a.js");
    s.updateContent("/x/a.js", "// rewritten with more content\n");
    await s.save("/x/a.js");
    // No refresh() was triggered by save.
    expect((api.listScripts as unknown as Mock).mock.calls.length).toBe(listBefore);
    // The in-memory entry was updated to reflect the new content.
    const entry = s.files.find((f) => f.path === "/x/a.js");
    expect(entry?.size).toBe("// rewritten with more content\n".length);
  });

  it("saveAs inserts a new entry into the file list without refresh()", async () => {
    const s = useScriptsStore();
    await s.refresh();
    const listBefore = (api.listScripts as unknown as Mock).mock.calls.length;
    await s.saveAs("/x/brand-new.js", "// hello\n");
    expect((api.listScripts as unknown as Mock).mock.calls.length).toBe(listBefore);
    expect(s.files.find((f) => f.path === "/x/brand-new.js")).toBeTruthy();
  });

  it("remove drops the file entry without refresh()", async () => {
    const s = useScriptsStore();
    await s.refresh();
    const listBefore = (api.listScripts as unknown as Mock).mock.calls.length;
    await s.remove("/x/a.js");
    expect((api.listScripts as unknown as Mock).mock.calls.length).toBe(listBefore);
    expect(s.files.find((f) => f.path === "/x/a.js")).toBeUndefined();
  });
});