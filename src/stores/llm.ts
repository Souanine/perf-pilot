import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { api, type LlmProviderConfig, type LlmTestResult } from "@/lib/tauri";
import { load as loadStore, type Store } from "@tauri-apps/plugin-store";

const STORE_FILE = "perf-pilot.settings.json";
const KEY_PROVIDERS = "llm.providers";
const KEY_ACTIVE = "llm.active";

let storeHandle: Store | null = null;
async function getStore(): Promise<Store> {
  if (!storeHandle) {
    storeHandle = await loadStore(STORE_FILE, { autoSave: true });
  }
  return storeHandle;
}

const DEFAULT_PROVIDERS: LlmProviderConfig[] = [
  {
    provider: "openai",
    base_url: "https://api.openai.com/v1",
    api_key: "",
    model: "gpt-4o-mini",
    organization: null,
    temperature: 0.2,
  },
  {
    provider: "anthropic",
    base_url: "https://api.anthropic.com",
    api_key: "",
    model: "claude-3-5-sonnet-latest",
    organization: null,
    temperature: 0.2,
  },
  {
    provider: "ollama",
    base_url: "http://localhost:11434/v1",
    api_key: "",
    model: "llama3.1",
    organization: null,
    temperature: 0.2,
  },
  {
    provider: "custom",
    base_url: "https://api.deepseek.com/v1",
    api_key: "",
    model: "deepseek-chat",
    organization: null,
    temperature: 0.2,
  },
];

export const useLLMStore = defineStore("llm", () => {
  const providers = ref<LlmProviderConfig[]>([...DEFAULT_PROVIDERS]);
  const activeId = ref<string>(DEFAULT_PROVIDERS[0].provider);
  const ready = ref(false);
  const testResults = ref<Record<string, LlmTestResult | null>>({});

  const active = computed(() =>
    providers.value.find((p) => p.provider === activeId.value) ?? providers.value[0],
  );

  async function hydrate() {
    const s = await getStore();
    const stored = await s.get<LlmProviderConfig[]>(KEY_PROVIDERS);
    if (stored && Array.isArray(stored) && stored.length > 0) {
      providers.value = stored;
    }
    const storedActive = await s.get<string>(KEY_ACTIVE);
    if (storedActive && providers.value.find((p) => p.provider === storedActive)) {
      activeId.value = storedActive;
    }
    ready.value = true;
  }

  function activeIdOf(p: LlmProviderConfig) {
    return p.provider;
  }

  function setActive(id: string) {
    if (providers.value.find((p) => p.provider === id)) {
      activeId.value = id;
    }
  }

  async function updateProvider(id: string, patch: Partial<LlmProviderConfig>) {
    const idx = providers.value.findIndex((p) => p.provider === id);
    if (idx === -1) return;
    providers.value[idx] = { ...providers.value[idx], ...patch };
    await persist();
  }

  async function addProvider(p: LlmProviderConfig) {
    if (providers.value.find((x) => x.provider === p.provider && x.base_url === p.base_url && x.model === p.model)) {
      return;
    }
    providers.value.push(p);
    await persist();
  }

  async function removeProvider(id: string) {
    providers.value = providers.value.filter((p) => p.provider !== id);
    if (activeId.value === id && providers.value.length > 0) {
      activeId.value = providers.value[0].provider;
    }
    await persist();
  }

  async function persist() {
    const s = await getStore();
    await s.set(KEY_PROVIDERS, providers.value);
    await s.set(KEY_ACTIVE, activeId.value);
    await s.save();
  }

  async function testActive(): Promise<LlmTestResult> {
    const result = await api.testLlm(active.value);
    testResults.value[active.value.provider] = result;
    return result;
  }

  watch(providers, () => persist(), { deep: true });
  watch(activeId, () => persist());

  return {
    providers,
    activeId,
    active,
    ready,
    testResults,
    activeIdOf,
    hydrate,
    setActive,
    updateProvider,
    addProvider,
    removeProvider,
    testActive,
  };
});