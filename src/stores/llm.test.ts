import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useLLMStore, migrateProvider } from "@/stores/llm";

describe("migrateProvider (legacy → new shape)", () => {
  it("upgrades an OpenAI legacy config", () => {
    const out = migrateProvider({
      provider: "openai",
      base_url: "https://api.openai.com/v1",
      api_key: "sk-test",
      model: "gpt-4o-mini",
      organization: null,
      temperature: 0.2,
    });
    expect(out.id).toBeTruthy();
    expect(out.name).toBe("openai");
    expect(out.api_format).toBe("chat_completions");
    expect(out.model).toBe("gpt-4o-mini");
    expect(out.models).toEqual([{ id: "gpt-4o-mini", label: "gpt-4o-mini" }]);
  });

  it("picks the anthropic_messages format for an Anthropic legacy config", () => {
    const out = migrateProvider({
      provider: "anthropic",
      base_url: "https://api.anthropic.com",
      api_key: "",
      model: "claude-3-5-sonnet-latest",
    });
    expect(out.api_format).toBe("anthropic_messages");
  });

  it("falls back to chat_completions for ollama / custom / unknown", () => {
    expect(
      migrateProvider({ provider: "ollama", base_url: "x", model: "llama3.1" }).api_format,
    ).toBe("chat_completions");
    expect(
      migrateProvider({ provider: "custom", base_url: "x", model: "deepseek-chat" }).api_format,
    ).toBe("chat_completions");
    expect(
      migrateProvider({ provider: "mystery", base_url: "x", model: "m" }).api_format,
    ).toBe("chat_completions");
  });

  it("passes through an already-migrated config", () => {
    const modern = {
      id: "p-1",
      name: "Work",
      api_format: "responses" as const,
      base_url: "https://proxy.local/v1",
      api_key: "k",
      model: "gpt-4o",
      organization: null,
      temperature: 0.1,
      models: [{ id: "gpt-4o", label: "GPT-4o" }],
    };
    const out = migrateProvider(modern);
    expect(out.id).toBe("p-1");
    expect(out.api_format).toBe("responses");
    expect(out.models).toEqual([{ id: "gpt-4o", label: "GPT-4o" }]);
  });

  it("builds an empty model catalog when model is empty", () => {
    const out = migrateProvider({
      provider: "openai",
      base_url: "x",
      model: "",
    });
    expect(out.models).toEqual([]);
  });

  it("assigns a unique id to every legacy migration", () => {
    const a = migrateProvider({ provider: "openai", base_url: "x", model: "m" });
    const b = migrateProvider({ provider: "openai", base_url: "x", model: "m" });
    expect(a.id).not.toBe(b.id);
  });
});

describe("useLLMStore (new shape)", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("ships with three default providers and uses the first as active", () => {
    const llm = useLLMStore();
    expect(llm.providers.length).toBeGreaterThanOrEqual(3);
    expect(llm.active).toBeDefined();
    expect(llm.active.id).toBe(llm.providers[0].id);
    // Each default provider must have an api_format and at least one model.
    for (const p of llm.providers) {
      expect(["chat_completions", "anthropic_messages", "responses"]).toContain(p.api_format);
      expect(p.models.length).toBeGreaterThan(0);
      expect(p.model).toBe(p.models[0].id);
    }
  });

  it("setActive switches the active pointer", () => {
    const llm = useLLMStore();
    const target = llm.providers[1];
    llm.setActive(target.id);
    expect(llm.active.id).toBe(target.id);
    expect(llm.activeId).toBe(target.id);
  });

  it("setActive ignores unknown ids", () => {
    const llm = useLLMStore();
    const before = llm.activeId;
    llm.setActive("does-not-exist");
    expect(llm.activeId).toBe(before);
  });

  it("addProvider pushes a new entry, makes it active, and migrates id", async () => {
    const llm = useLLMStore();
    const beforeCount = llm.providers.length;
    await llm.addProvider({
      name: "Test proxy",
      api_format: "chat_completions",
      base_url: "https://proxy.local/v1",
      api_key: "sk-x",
      model: "claude-test",
      organization: null,
      temperature: 0.3,
      models: [{ id: "claude-test", label: "Test" }],
    });
    expect(llm.providers.length).toBe(beforeCount + 1);
    expect(llm.activeId).toBe(llm.providers[llm.providers.length - 1].id);
    expect(llm.active.name).toBe("Test proxy");
  });

  it("addProvider generates an id when none is provided", async () => {
    const llm = useLLMStore();
    await llm.addProvider({
      name: "IDless",
      api_format: "chat_completions",
      base_url: "x",
      api_key: "",
      model: "m",
      organization: null,
      temperature: 0.2,
      models: [],
    });
    const last = llm.providers[llm.providers.length - 1];
    expect(last.id).toBeTruthy();
    expect(last.id.length).toBeGreaterThan(8);
  });

  it("addProvider dedupes by id", async () => {
    const llm = useLLMStore();
    const before = llm.providers.length;
    const first = llm.providers[0];
    await llm.addProvider({
      id: first.id,
      name: "Dup",
      api_format: first.api_format,
      base_url: first.base_url,
      api_key: first.api_key,
      model: first.model,
      organization: null,
      temperature: first.temperature,
      models: first.models,
    });
    expect(llm.providers.length).toBe(before);
  });

  it("addModel appends to the catalog and dedupes", () => {
    const llm = useLLMStore();
    const id = llm.activeId;
    const before = llm.active.models.length;
    llm.addModel(id, { id: "new-model-1", label: "New Model 1" });
    expect(llm.active.models.length).toBe(before + 1);
    expect(llm.active.models.at(-1)?.id).toBe("new-model-1");
    llm.addModel(id, { id: "new-model-1", label: "x" }); // duplicate
    expect(llm.active.models.length).toBe(before + 1);
  });

  it("addModel ignores empty ids and unknown providers", () => {
    const llm = useLLMStore();
    const before = llm.active.models.length;
    llm.addModel(llm.activeId, { id: "   ", label: "x" });
    expect(llm.active.models.length).toBe(before);
    llm.addModel("does-not-exist", { id: "y" });
    expect(llm.active.models.length).toBe(before);
  });

  it("removeModel drops the entry and falls back when the active is removed", () => {
    const llm = useLLMStore();
    const id = llm.activeId;
    llm.addModel(id, { id: "throwaway", label: "x" });
    llm.updateProvider(id, { model: "throwaway" });
    expect(llm.active.model).toBe("throwaway");
    llm.removeModel(id, "throwaway");
    expect(llm.active.models.find((m) => m.id === "throwaway")).toBeUndefined();
    // Active model should fall back to the first remaining.
    expect(llm.active.model).toBe(llm.active.models[0].id);
  });

  it("setActiveModel changes the current model without touching others", () => {
    const llm = useLLMStore();
    const id = llm.activeId;
    // Add an extra model so we have something to switch to.
    llm.addModel(id, { id: "alt-model", label: "Alt" });
    const before = { ...llm.active };
    llm.setActiveModel("alt-model");
    expect(llm.active.model).toBe("alt-model");
    expect(llm.active.api_format).toBe(before.api_format);
    expect(llm.active.base_url).toBe(before.base_url);
  });

  it("setActiveModel ignores unknown model ids", () => {
    const llm = useLLMStore();
    const before = llm.active.model;
    llm.setActiveModel("does-not-exist");
    expect(llm.active.model).toBe(before);
  });

  it("removeProvider rotates the active pointer when the active is removed", async () => {
    const llm = useLLMStore();
    const firstId = llm.providers[0].id;
    llm.setActive(firstId);
    await llm.removeProvider(firstId);
    expect(llm.activeId).not.toBe(firstId);
    expect(llm.active).toBeDefined();
  });

  it("updateProvider adds an unknown active model to the catalog", async () => {
    const llm = useLLMStore();
    const id = llm.activeId;
    const beforeCount = llm.active.models.length;
    await llm.updateProvider(id, { model: "brand-new-model-id" });
    expect(llm.active.model).toBe("brand-new-model-id");
    expect(llm.active.models.length).toBe(beforeCount + 1);
    expect(llm.active.models.find((m) => m.id === "brand-new-model-id")).toBeDefined();
  });
});