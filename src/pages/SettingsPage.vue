<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Loader2, Plus, Trash2, CheckCircle2, AlertTriangle, Save } from "lucide-vue-next";
import Card from "@/components/ui/Card.vue";
import CardContent from "@/components/ui/CardContent.vue";
import CardHeader from "@/components/ui/CardHeader.vue";
import CardTitle from "@/components/ui/CardTitle.vue";
import CardDescription from "@/components/ui/CardDescription.vue";
import Button from "@/components/ui/Button.vue";
import Input from "@/components/ui/Input.vue";
import Label from "@/components/ui/Label.vue";
import Select from "@/components/ui/Select.vue";
import Badge from "@/components/ui/Badge.vue";
import { useLLMStore } from "@/stores/llm";
import { useToastStore } from "@/stores/toast";
import { api, type LlmProviderConfig } from "@/lib/tauri";

const llm = useLLMStore();
const toast = useToastStore();
const { t } = useI18n();

const providerOptions = [
  { label: "OpenAI", value: "openai" },
  { label: "Anthropic", value: "anthropic" },
  { label: "Ollama (local)", value: "ollama" },
  { label: "Custom OpenAI-compatible", value: "custom" },
];

const newProvider = ref<LlmProviderConfig>({
  provider: "custom",
  base_url: "",
  api_key: "",
  model: "",
  organization: null,
  temperature: 0.2,
});

const testing = ref<string | null>(null);

const providerDefaults = computed(() => {
  return {
    openai: { base_url: "https://api.openai.com/v1", model: "gpt-4o-mini" },
    anthropic: { base_url: "https://api.anthropic.com", model: "claude-3-5-sonnet-latest" },
    ollama: { base_url: "http://localhost:11434/v1", model: "llama3.1" },
    custom: { base_url: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  };
});

function applyDefaults(kind: LlmProviderConfig["provider"]) {
  const d = providerDefaults.value[kind];
  if (d) {
    newProvider.value.base_url = d.base_url;
    newProvider.value.model = d.model;
  }
}

async function addProvider() {
  if (!newProvider.value.base_url || !newProvider.value.model) {
    toast.push({ title: t('settings.baseUrlRequired'), variant: "warning" });
    return;
  }
  // Make the provider id unique
  let id: LlmProviderConfig["provider"] = newProvider.value.provider;
  let i = 1;
  while (llm.providers.find((p) => p.provider === id)) {
    // Custom suffixes keep the LlmProviderConfig["provider"] literal type intact.
    id = `${newProvider.value.provider}-${i++}` as LlmProviderConfig["provider"];
  }
  await llm.addProvider({ ...newProvider.value, provider: id });
  toast.push({ title: "Provider added", variant: "success" });
  newProvider.value = {
    provider: "custom",
    base_url: "",
    api_key: "",
    model: "",
    organization: null,
    temperature: 0.2,
  };
}

async function testOne(p: LlmProviderConfig) {
  testing.value = p.provider;
  try {
    const r = await api.testLlm(p);
    if (r.ok) {
      toast.push({ title: "OK", description: r.message, variant: "success" });
    } else {
      toast.push({ title: "Failed", description: r.message, variant: "destructive" });
    }
  } catch (e: unknown) {
    toast.push({
      title: t('ai.errorTest'),
      description: e instanceof Error ? e.message : String(e),
      variant: "destructive",
    });
  } finally {
    testing.value = null;
  }
}

function maskKey(k: string) {
  if (!k) return "";
  if (k.length <= 8) return "•".repeat(k.length);
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

function update<K extends keyof LlmProviderConfig>(
  p: LlmProviderConfig,
  key: K,
  value: LlmProviderConfig[K],
) {
  llm.updateProvider(p.provider, { [key]: value } as Partial<LlmProviderConfig>);
}

onMounted(async () => {
  if (!llm.ready) await llm.hydrate();
});
</script>

<template>
  <div class="h-full overflow-auto p-6">
    <div class="mx-auto flex max-w-4xl flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{{ t('settings.title') }}</CardTitle>
          <CardDescription>
            {{ t('settings.subtitle') }}
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <div
            v-for="p in llm.providers"
            :key="p.provider"
            class="rounded-lg border border-border p-4"
          >
            <div class="mb-3 flex items-center gap-2">
              <Badge :variant="llm.activeId === p.provider ? 'success' : 'secondary'">
                {{ llm.activeId === p.provider ? t('common.enabled') : t('common.disabled') }}
              </Badge>
              <span class="text-sm font-semibold">{{ p.provider }}</span>
              <span class="text-xs text-muted-foreground">{{ p.base_url }}</span>
              <div class="ml-auto flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  @click="testOne(p)"
                  :disabled="testing === p.provider"
                >
                  <Loader2 v-if="testing === p.provider" class="h-3 w-3 animate-spin" />
                  <CheckCircle2 v-else class="h-3 w-3" />
                  Test
                </Button>
                <Button
                  v-if="llm.activeId !== p.provider"
                  size="sm"
                  variant="outline"
                  @click="llm.setActive(p.provider)"
                >
                  {{ t('settings.setActive') }}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  class="text-destructive"
                  @click="llm.removeProvider(p.provider)"
                  :disabled="llm.providers.length <= 1"
                >
                  <Trash2 class="h-3 w-3" />
                </Button>
              </div>
            </div>
            <div class="grid gap-3 md:grid-cols-2">
              <div>
                <Label class="mb-1 block text-xs">{{ t('settings.baseUrl') }}</Label>
                <Input
                  :modelValue="p.base_url"
                  @update:modelValue="update(p, 'base_url', $event)"
                />
              </div>
              <div>
                <Label class="mb-1 block text-xs">{{ t('settings.model') }}</Label>
                <Input
                  :modelValue="p.model"
                  @update:modelValue="update(p, 'model', $event)"
                />
              </div>
              <div>
                <Label class="mb-1 block text-xs">
                  {{ t('settings.apiKey') }}
                  <span v-if="p.api_key" class="ml-1 text-xs text-muted-foreground">
                    ({{ maskKey(p.api_key) }})
                  </span>
                </Label>
                <Input
                  type="password"
                  :modelValue="p.api_key"
                  @update:modelValue="update(p, 'api_key', $event)"
                  placeholder="sk-…"
                />
              </div>
              <div>
                <Label class="mb-1 block text-xs">{{ t('settings.organization') }}</Label>
                <Input
                  :modelValue="p.organization ?? ''"
                  @update:modelValue="update(p, 'organization', $event || null)"
                  placeholder="org-…"
                />
              </div>
              <div class="md:col-span-2">
                <Label class="mb-1 block text-xs">{{ t('settings.temperature') }}</Label>
                <div class="flex items-center gap-3">
                  <Input
                    type="number"
                    step="0.05"
                    min="0"
                    max="2"
                    :modelValue="String(p.temperature)"
                    @update:modelValue="update(p, 'temperature', Number($event) || 0)"
                  />
                  <span class="text-xs text-muted-foreground">{{ t('settings.temperatureHelp') }}</span>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <Plus class="h-4 w-4" /> {{ t('settings.addProvider') }}
          </CardTitle>
          <CardDescription>
            Settings are stored locally via the Tauri store plugin.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-3">
          <div class="grid gap-3 md:grid-cols-2">
            <div>
              <Label class="mb-1 block text-xs">{{ t('settings.typeLabel') }}</Label>
              <Select
                :modelValue="newProvider.provider"
                :options="providerOptions"
                @update:modelValue="(v) => {
                  newProvider.provider = v as LlmProviderConfig['provider'];
                  applyDefaults(newProvider.provider);
                }"
              />
            </div>
            <div>
              <Label class="mb-1 block text-xs">Base URL</Label>
              <Input v-model="newProvider.base_url" />
            </div>
            <div>
              <Label class="mb-1 block text-xs">Model</Label>
              <Input v-model="newProvider.model" />
            </div>
            <div>
              <Label class="mb-1 block text-xs">{{ t('settings.apiKey') }}</Label>
              <Input type="password" v-model="newProvider.api_key" />
            </div>
          </div>
          <div class="flex justify-end">
            <Button @click="addProvider">
              <Save class="h-4 w-4" /> {{ t('settings.saveProvider') }}
            </Button>
          </div>
          <div class="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle class="mr-1 inline h-3 w-3" />
            {{ t('settings.apiKeyHint') }}
            (<code class="font-mono">{{ "{app_data_dir}/perf-pilot.settings.json" }}</code>).
            On macOS this is <code class="font-mono">~/Library/Application Support/dev.perfpilot.app/</code>.
          </div>
        </CardContent>
      </Card>
    </div>
  </div>
</template>