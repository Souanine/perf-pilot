import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useLLMStore } from "@/stores/llm";

describe("llm store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("ships with 4 sensible default providers", () => {
    const llm = useLLMStore();
    expect(llm.providers.length).toBe(4);
    const kinds = llm.providers.map((p) => p.provider);
    expect(kinds).toContain("openai");
    expect(kinds).toContain("anthropic");
    expect(kinds).toContain("ollama");
    expect(kinds).toContain("custom");
  });

  it("active defaults to the first provider", () => {
    const llm = useLLMStore();
    expect(llm.active.provider).toBe("openai");
    expect(llm.activeId).toBe("openai");
  });

  it("setActive switches the active provider", () => {
    const llm = useLLMStore();
    llm.setActive("custom");
    expect(llm.activeId).toBe("custom");
    expect(llm.active.provider).toBe("custom");
  });

  it("setActive ignores unknown ids", () => {
    const llm = useLLMStore();
    llm.setActive("does-not-exist");
    expect(llm.activeId).toBe("openai");
  });

  it("updateProvider patches fields without losing others", async () => {
    const llm = useLLMStore();
    llm.updateProvider("custom", { base_url: "http://localhost:9999/v1" });
    const custom = llm.providers.find((p) => p.provider === "custom");
    expect(custom?.base_url).toBe("http://localhost:9999/v1");
    expect(custom?.model).toBe("deepseek-chat"); // default unchanged
  });

  it("removeProvider switches active if the removed one was active", async () => {
    const llm = useLLMStore();
    llm.setActive("ollama");
    llm.removeProvider("ollama");
    expect(llm.providers.find((p) => p.provider === "ollama")).toBeUndefined();
    expect(llm.activeId).not.toBe("ollama");
  });
});