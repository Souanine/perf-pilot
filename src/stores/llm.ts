import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { api, type LlmProviderConfig, type LlmModelSpec, type ApiFormat, type LlmTestResult } from "@/lib/tauri";
import { load as loadStore, type Store } from "@tauri-apps/plugin-store";

const STORE_FILE = "perf-pilot.settings.json";
const KEY_PROVIDERS = "llm.providers";
const KEY_ACTIVE = "llm.active";

/** Settings writes coalesce — typing in the LLM Settings form fires one
 *  mutation per keystroke, and `watch(providers, …)` would otherwise
 *  rewrite the whole JSON file on every change. */
const PERSIST_DEBOUNCE_MS = 300;

let storeHandle: Store | null = null;
async function getStore(): Promise<Store> {
  if (!storeHandle) {
    storeHandle = await loadStore(STORE_FILE, { autoSave: true });
  }
  return storeHandle;
}

/** Build a v4-ish unique id without pulling in the `uuid` npm package.
 *  crypto.randomUUID is available in every modern WebView Tauri 2 ships. */
function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return "p-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

interface LegacyProvider {
  provider?: string;
  base_url?: string;
  api_key?: string;
  model?: string;
  organization?: string | null;
  temperature?: number;
  api_format?: ApiFormat;
  id?: string;
  name?: string;
  models?: LlmModelSpec[];
}

const DEFAULT_PROVIDERS: LlmProviderConfig[] = [
  {
    id: "default-openai",
    name: "OpenAI",
    api_format: "chat_completions",
    base_url: "https://api.openai.com/v1",
    api_key: "",
    model: "gpt-4o-mini",
    organization: null,
    temperature: 0.2,
    models: [{ id: "gpt-4o-mini", label: "GPT-4o mini" }],
  },
  {
    id: "default-anthropic",
    name: "Anthropic",
    api_format: "anthropic_messages",
    base_url: "https://api.anthropic.com",
    api_key: "",
    model: "claude-3-5-sonnet-latest",
    organization: null,
    temperature: 0.2,
    models: [{ id: "claude-3-5-sonnet-latest", label: "Claude 3.5 Sonnet" }],
  },
  {
    id: "default-ollama",
    name: "Ollama (local)",
    api_format: "chat_completions",
    base_url: "http://localhost:11434/v1",
    api_key: "",
    model: "llama3.1",
    organization: null,
    temperature: 0.2,
    models: [
      { id: "llama3.1", label: "Llama 3.1" },
      { id: "qwen2.5", label: "Qwen 2.5" },
      { id: "deepseek-r1", label: "DeepSeek R1" },
    ],
  },
];

/** Migrate a single provider object from the legacy shape (provider:
 *  "openai" | "anthropic" | "ollama" | "custom", single model string) to
 *  the new shape (id, name, api_format, models[]). Idempotent: passing
 *  an already-migrated object returns it untouched. */
export function migrateProvider(raw: unknown): LlmProviderConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("migrateProvider: expected an object");
  }
  const p = raw as LegacyProvider;
  // If the new fields are already present, hydrate as-is (after defaults).
  if (p.id && p.name && p.api_format && Array.isArray(p.models)) {
    return {
      id: p.id,
      name: p.name,
      api_format: p.api_format,
      base_url: p.base_url ?? "",
      api_key: p.api_key ?? "",
      model: p.model ?? p.models[0]?.id ?? "",
      organization: p.organization ?? null,
      temperature: p.temperature ?? 0.2,
      models: p.models,
    };
  }
  // Legacy path.
  const legacy = p.provider ?? "custom";
  const api_format: ApiFormat = legacy === "anthropic" ? "anthropic_messages" : "chat_completions";
  const model = p.model ?? "";
  const models: LlmModelSpec[] = model
    ? [{ id: model, label: model }]
    : [];
  return {
    id: newId(),
    name: legacy,
    api_format,
    base_url: p.base_url ?? "",
    api_key: p.api_key ?? "",
    model,
    organization: p.organization ?? null,
    temperature: p.temperature ?? 0.2,
    models,
  };
}

export const useLLMStore = defineStore("llm", () => {
  const providers = ref<LlmProviderConfig[]>(DEFAULT_PROVIDERS.map((p) => ({ ...p })));
  const activeId = ref<string>(DEFAULT_PROVIDERS[0].id);
  const ready = ref(false);
  const testResults = ref<Record<string, LlmTestResult | null>>({});

  const active = computed(
    () => providers.value.find((p) => p.id === activeId.value) ?? providers.value[0],
  );

  async function hydrate() {
    const s = await getStore();
    const stored = await s.get<unknown[]>(KEY_PROVIDERS);
    if (Array.isArray(stored) && stored.length > 0) {
      providers.value = stored.map(migrateProvider);
    }
    const storedActive = await s.get<string>(KEY_ACTIVE);
    if (storedActive && providers.value.find((p) => p.id === storedActive)) {
      activeId.value = storedActive;
    } else if (providers.value.length > 0) {
      // First-time launch with no active id — default to first provider.
      activeId.value = providers.value[0].id;
    }
    ready.value = true;
  }

  function setActive(id: string) {
    if (providers.value.find((p) => p.id === id)) {
      activeId.value = id;
    }
  }

  /** Switch the *model* for an already-active provider without touching
   *  the provider's other settings. Used by the AI Generate page when
   *  the user picks a different model from the catalog dropdown. */
  function setActiveModel(modelId: string) {
    const p = active.value;
    if (!p) return;
    if (!p.models.find((m) => m.id === modelId)) return;
    p.model = modelId;
    schedulePersist();
  }

  async function updateProvider(id: string, patch: Partial<LlmProviderConfig>) {
    const idx = providers.value.findIndex((p) => p.id === id);
    if (idx === -1) return;
    const next = { ...providers.value[idx], ...patch };
    // If the user changed the active model id, make sure it's in the catalog.
    if (patch.model && !next.models.find((m) => m.id === patch.model)) {
      next.models = [...next.models, { id: patch.model, label: patch.model }];
    }
    providers.value[idx] = next;
    schedulePersist();
  }

  async function addProvider(p: Omit<LlmProviderConfig, "id"> & { id?: string }) {
    const id = p.id ?? newId();
    // Build a sensible default catalog if the caller didn't supply one.
    const models: LlmModelSpec[] = p.models && p.models.length > 0
      ? p.models
      : p.model
        ? [{ id: p.model, label: p.model }]
        : [];
    const next: LlmProviderConfig = {
      ...p,
      id,
      models,
    };
    // Refuse exact dupes by id.
    if (providers.value.find((x) => x.id === id)) return;
    providers.value.push(next);
    // Newly added providers become the active one — the user almost
    // always wants to try what they just added.
    activeId.value = id;
    schedulePersist();
  }

  async function removeProvider(id: string) {
    providers.value = providers.value.filter((p) => p.id !== id);
    if (activeId.value === id && providers.value.length > 0) {
      activeId.value = providers.value[0].id;
    }
    schedulePersist();
  }

  function addModel(providerId: string, model: LlmModelSpec) {
    const p = providers.value.find((x) => x.id === providerId);
    if (!p) return;
    const id = model.id.trim();
    if (!id) return;
    if (p.models.find((m) => m.id === id)) return; // duplicate
    p.models = [...p.models, { id, label: model.label?.trim() || id }];
    // If there's no current model yet, adopt this one.
    if (!p.model) {
      p.model = id;
    }
    schedulePersist();
  }

  function removeModel(providerId: string, modelId: string) {
    const p = providers.value.find((x) => x.id === providerId);
    if (!p) return;
    p.models = p.models.filter((m) => m.id !== modelId);
    if (p.model === modelId) {
      // Fall back to the first remaining model, or empty if none.
      p.model = p.models[0]?.id ?? "";
    }
    schedulePersist();
  }

  async function persist() {
    const s = await getStore();
    await s.set(KEY_PROVIDERS, providers.value);
    await s.set(KEY_ACTIVE, activeId.value);
    await s.save();
  }

  /** Debounced variant used by every mutator + the deep watcher below.
   *  Subsequent calls inside the window reset the timer, so a rapid
   *  burst of edits (e.g. typing a base URL) results in one disk write
   *  instead of N. */
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  function schedulePersist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persist().catch((e) => console.error("persist llm settings failed", e));
    }, PERSIST_DEBOUNCE_MS);
  }

  /** Tests and store-loader callers (e.g. `hydrate`) need a way to flush
   *  pending writes deterministically without waiting on the timer. */
  async function flushPersist() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    await persist();
  }

  async function testActive(): Promise<LlmTestResult> {
    const result = await api.testLlm(active.value);
    testResults.value[active.value.id] = result;
    return result;
  }

  /** Probe a specific provider by id (used by the per-provider "Test"
   *  button on the Settings page). Falls back to the active provider
   *  if the id is unknown. Result is cached in `testResults` so the
   *  badge state stays consistent with `testActive`. */
  async function testOne(id: string): Promise<LlmTestResult | null> {
    const provider = providers.value.find((p) => p.id === id);
    if (!provider) return null;
    const result = await api.testLlm(provider);
    testResults.value[id] = result;
    return result;
  }

  watch(providers, () => schedulePersist(), { deep: true });
  watch(activeId, () => schedulePersist());

  return {
    providers,
    activeId,
    active,
    ready,
    testResults,
    hydrate,
    setActive,
    setActiveModel,
    updateProvider,
    addProvider,
    removeProvider,
    addModel,
    removeModel,
    testActive,
    testOne,
    flushPersist,
  };
});