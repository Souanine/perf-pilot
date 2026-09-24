import { describe, it, expect, beforeEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useReportsStore } from "@/stores/reports";
import { useLLMStore } from "@/stores/llm";
import { useLocaleStore } from "@/stores/locale";

// Mock the tauri bridge so the store never hits the real IPC layer.
vi.mock("@/lib/tauri", () => {
  return {
    api: {
      listReports: vi.fn(),
      readReport: vi.fn(),
      deleteReport: vi.fn(),
      generateReport: vi.fn(),
    },
  };
});

import { api } from "@/lib/tauri";
const mockedApi = api as unknown as {
  listReports: ReturnType<typeof vi.fn>;
  readReport: ReturnType<typeof vi.fn>;
  deleteReport: ReturnType<typeof vi.fn>;
  generateReport: ReturnType<typeof vi.fn>;
};

describe("useReportsStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("refresh() populates the index from api.listReports", async () => {
    mockedApi.listReports.mockResolvedValueOnce([
      {
        run_id: "r1",
        path: "/x/r1.md",
        model: "qwen",
        created_at: "2026-09-25T00:00:00Z",
        size: 42,
      },
    ]);
    const store = useReportsStore();
    await store.refresh();
    expect(store.forRun("r1")?.model).toBe("qwen");
    expect(store.hasReport).toBe(true);
  });

  it("refresh() swallows errors so the UI stays usable", async () => {
    mockedApi.listReports.mockRejectedValueOnce(new Error("boom"));
    const store = useReportsStore();
    await store.refresh();
    expect(Object.keys(store.index)).toHaveLength(0);
  });

  it("load() fetches body on demand and caches it", async () => {
    mockedApi.readReport.mockResolvedValueOnce("# Hello\n\nworld");
    const store = useReportsStore();
    const body = await store.load("r1");
    expect(body).toBe("# Hello\n\nworld");
    expect(store.openRunId).toBe("r1");
    expect(store.openBody).toBe("# Hello\n\nworld");
    // Second call must not re-fetch.
    const body2 = await store.load("r1");
    expect(body2).toBe("# Hello\n\nworld");
    expect(mockedApi.readReport).toHaveBeenCalledTimes(1);
  });

  it("load() returns null and records an error on failure", async () => {
    mockedApi.readReport.mockRejectedValueOnce(new Error("disk gone"));
    const store = useReportsStore();
    const body = await store.load("r1");
    expect(body).toBeNull();
    expect(store.errorFor("r1")).toContain("disk gone");
  });

  it("generate() uses the active LLM and stores the report", async () => {
    // Seed the LLM store with an active provider.
    const llm = useLLMStore();
    llm.providers = [
      {
        provider: "openai",
        base_url: "https://api.example.com/v1",
        api_key: "sk-test",
        model: "gpt-x",
        organization: null,
        temperature: 0.2,
      },
    ];
    llm.activeId = "openai";
    // Locale store defaults to "en".
    useLocaleStore();

    mockedApi.generateReport.mockResolvedValueOnce({
      report: "# Report\n\nOK.",
      model: "gpt-x",
      tokens_in: 10,
      tokens_out: 20,
    });

    const store = useReportsStore();
    const resp = await store.generate("r1");
    expect(resp?.model).toBe("gpt-x");
    expect(mockedApi.generateReport).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-x" }),
      expect.objectContaining({ run_id: "r1", locale: "en" }),
    );
    expect(store.forRun("r1")?.body).toBe("# Report\n\nOK.");
    expect(store.openRunId).toBe("r1");
    expect(store.isGenerating("r1")).toBe(false);
  });

  it("generate() short-circuits when no active model is configured", async () => {
    const llm = useLLMStore();
    llm.providers = [];
    llm.activeId = "none";
    useLocaleStore();
    const store = useReportsStore();
    const resp = await store.generate("r1");
    expect(resp).toBeNull();
    expect(store.errorFor("r1")).toMatch(/No active LLM/);
    expect(mockedApi.generateReport).not.toHaveBeenCalled();
  });

  it("generate() records errors and clears the busy flag", async () => {
    const llm = useLLMStore();
    llm.providers = [
      {
        provider: "openai",
        base_url: "https://x",
        api_key: "",
        model: "m",
        organization: null,
        temperature: 0.2,
      },
    ];
    llm.activeId = "openai";
    useLocaleStore();
    mockedApi.generateReport.mockRejectedValueOnce(new Error("HTTP 502"));

    const store = useReportsStore();
    const resp = await store.generate("r1");
    expect(resp).toBeNull();
    expect(store.errorFor("r1")).toContain("HTTP 502");
    expect(store.isGenerating("r1")).toBe(false);
  });

  it("discard() drops the cached entry and closes the viewer", async () => {
    mockedApi.deleteReport.mockResolvedValueOnce(undefined);
    const store = useReportsStore();
    store.index = {
      r1: {
        run_id: "r1",
        path: "",
        model: "m",
        created_at: "2026-09-25T00:00:00Z",
        size: 1,
        body: "x",
        loading: false,
      },
    };
    store.openRunId = "r1";
    store.openBody = "x";
    await store.discard("r1");
    expect(store.forRun("r1")).toBeNull();
    expect(store.openRunId).toBeNull();
    expect(store.openBody).toBeNull();
  });

  it("close() clears open run without deleting the index entry", () => {
    const store = useReportsStore();
    store.index = {
      r1: {
        run_id: "r1",
        path: "",
        model: "m",
        created_at: "2026-09-25T00:00:00Z",
        size: 1,
        body: "x",
        loading: false,
      },
    };
    store.openRunId = "r1";
    store.openBody = "x";
    store.close();
    expect(store.openRunId).toBeNull();
    expect(store.openBody).toBeNull();
    expect(store.forRun("r1")?.body).toBe("x");
  });
});