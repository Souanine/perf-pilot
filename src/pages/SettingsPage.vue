<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  Loader2,
  Plus,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  Save,
  ChevronDown,
  ChevronRight,
  X,
  GripVertical,
} from "lucide-vue-next";
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
import { api, type ApiFormat, type LlmProviderConfig } from "@/lib/tauri";

const llm = useLLMStore();
const toast = useToastStore();
const { t } = useI18n();

interface FormatOption {
  value: ApiFormat;
  label: string;
  endpoint: string;
}

const formatOptions: FormatOption[] = [
  { value: "chat_completions", label: "OpenAI Chat Completions", endpoint: "/chat/completions" },
  { value: "anthropic_messages", label: "Anthropic Messages", endpoint: "/v1/messages" },
  { value: "responses", label: "OpenAI Responses", endpoint: "/responses" },
];

function formatLabel(f: ApiFormat): string {
  return formatOptions.find((o) => o.value === f)?.label ?? f;
}

function formatEndpoint(f: ApiFormat): string {
  return formatOptions.find((o) => o.value === f)?.endpoint ?? "";
}

/** Form-state shape for a new provider. We keep it loose (api_format as
 *  a string, model as a single free-text field) until the user clicks
 *  Save, then collapse it into the strict LlmProviderConfig shape. */
interface NewProviderDraft {
  name: string;
  api_format: ApiFormat;
  base_url: string;
  api_key: string;
  model: string;
  organization: string;
  temperature: number;
}

const blankDraft = (): NewProviderDraft => ({
  name: "",
  api_format: "chat_completions",
  base_url: "",
  api_key: "",
  model: "",
  organization: "",
  temperature: 0.2,
});

const newDraft = ref<NewProviderDraft>(blankDraft());
const addOpen = ref(false);
const testing = ref<string | null>(null);

const expanded = ref<Record<string, boolean>>({});

function toggleExpanded(id: string) {
  expanded.value[id] = !(expanded.value[id] ?? true);
}

function maskKey(k: string) {
  if (!k) return "";
  if (k.length <= 8) return "•".repeat(k.length);
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

const draftModelInput = ref<Record<string, string>>({});

async function saveNew() {
  const d = newDraft.value;
  if (!d.name.trim()) {
    toast.push({ title: t('settings.nameRequired'), variant: "warning" });
    return;
  }
  if (!d.base_url.trim() || !d.model.trim()) {
    toast.push({ title: t('settings.baseUrlRequired'), variant: "warning" });
    return;
  }
  // Use the typed model id as both the active model and the first
  // catalog entry so the provider is immediately usable.
  const modelId = d.model.trim();
  await llm.addProvider({
    name: d.name.trim(),
    api_format: d.api_format,
    base_url: d.base_url.trim(),
    api_key: d.api_key.trim(),
    model: modelId,
    organization: d.organization.trim() || null,
    temperature: d.temperature,
    models: [{ id: modelId, label: modelId }],
  });
  toast.push({ title: t('settings.providerAdded'), variant: "success" });
  newDraft.value = blankDraft();
  addOpen.value = false;
}

async function testOne(p: LlmProviderConfig) {
  testing.value = p.id;
  try {
    // Route through the store so `testResults` is populated — that
    // gives the badge on each provider card a stable source instead
    // of recomputing on every render.
    const r = await llm.testOne(p.id);
    if (r) {
      toast.push({
        title: r.ok ? t('status.passed') : t('status.errored'),
        description: r.message,
        variant: r.ok ? "success" : "destructive",
      });
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

function addModel(providerId: string) {
  const raw = (draftModelInput.value[providerId] ?? "").trim();
  if (!raw) return;
  // Allow the user to type "id" or "id | display name".
  const [id, ...rest] = raw.split("|");
  const cleanId = id.trim();
  const label = rest.length > 0 ? rest.join("|").trim() : cleanId;
  if (!cleanId) return;
  llm.addModel(providerId, { id: cleanId, label });
  draftModelInput.value[providerId] = "";
}

function removeModel(providerId: string, modelId: string) {
  llm.removeModel(providerId, modelId);
}

function pickModel(providerId: string, modelId: string) {
  llm.updateProvider(providerId, { model: modelId });
}

function updateField<K extends keyof LlmProviderConfig>(
  p: LlmProviderConfig,
  key: K,
  value: LlmProviderConfig[K],
) {
  llm.updateProvider(p.id, { [key]: value } as Partial<LlmProviderConfig>);
}

function updateModelInput(providerId: string, value: string) {
  draftModelInput.value[providerId] = value;
}

const modelsByProvider = computed<Record<string, typeof llm.providers[number]["models"]>>(() => {
  const map: Record<string, typeof llm.providers[number]["models"]> = {};
  for (const p of llm.providers) {
    map[p.id] = p.models;
  }
  return map;
});

const isExpanded = (id: string) => expanded.value[id] ?? true;

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
        <CardContent class="space-y-3">
          <div
            v-for="p in llm.providers"
            :key="p.id"
            class="rounded-lg border border-border"
            :class="llm.activeId === p.id ? 'border-primary/40 bg-primary/5' : ''"
          >
            <!-- Header strip: name + format + actions -->
            <div class="flex items-center gap-2 border-b border-border p-3">
              <button
                class="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent"
                :aria-label="isExpanded(p.id) ? t('settings.collapse') : t('settings.expand')"
                @click="toggleExpanded(p.id)"
              >
                <component
                  :is="isExpanded(p.id) ? ChevronDown : ChevronRight"
                  class="h-3.5 w-3.5"
                />
              </button>
              <Badge :variant="llm.activeId === p.id ? 'success' : 'secondary'">
                {{ llm.activeId === p.id ? t('common.enabled') : t('common.disabled') }}
              </Badge>
              <span class="text-sm font-semibold">{{ p.name }}</span>
              <code class="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground">
                {{ formatLabel(p.api_format) }} · {{ formatEndpoint(p.api_format) }}
              </code>
              <span class="text-xs text-muted-foreground">{{ p.base_url }}</span>
              <div class="ml-auto flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  @click="testOne(p)"
                  :disabled="testing === p.id"
                >
                  <Loader2 v-if="testing === p.id" class="h-3 w-3 animate-spin" />
                  <CheckCircle2 v-else class="h-3 w-3" />
                  {{ t('settings.test') }}
                </Button>
                <Button
                  v-if="llm.activeId !== p.id"
                  size="sm"
                  variant="outline"
                  @click="llm.setActive(p.id)"
                >
                  {{ t('settings.setActive') }}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  class="text-destructive"
                  @click="llm.removeProvider(p.id)"
                  :disabled="llm.providers.length <= 1"
                  :aria-label="t('common.delete')"
                >
                  <Trash2 class="h-3 w-3" />
                </Button>
              </div>
            </div>

            <!-- Body: full editor -->
            <div v-if="isExpanded(p.id)" class="space-y-4 p-4">
              <div class="grid gap-3 md:grid-cols-2">
                <div>
                  <Label class="mb-1 block text-xs">{{ t('settings.name') }}</Label>
                  <Input
                    :modelValue="p.name"
                    :aria-label="`${p.name} ${t('settings.name')}`"
                    @update:modelValue="updateField(p, 'name', $event)"
                  />
                </div>
                <div>
                  <Label class="mb-1 block text-xs">{{ t('settings.apiFormat') }}</Label>
                  <Select
                    :modelValue="p.api_format"
                    :options="formatOptions.map(o => ({ label: `${o.label} (${o.endpoint})`, value: o.value }))"
                    :aria-label="`${p.name} ${t('settings.apiFormat')}`"
                    @update:modelValue="updateField(p, 'api_format', $event as ApiFormat)"
                  />
                </div>
                <div class="md:col-span-2">
                  <Label class="mb-1 block text-xs">{{ t('settings.baseUrl') }}</Label>
                  <Input
                    :modelValue="p.base_url"
                    :aria-label="`${p.name} ${t('settings.baseUrl')}`"
                    @update:modelValue="updateField(p, 'base_url', $event)"
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
                    :aria-label="`${p.name} ${t('settings.apiKey')}`"
                    @update:modelValue="updateField(p, 'api_key', $event)"
                    placeholder="sk-…"
                  />
                </div>
                <div>
                  <Label class="mb-1 block text-xs">{{ t('settings.organization') }}</Label>
                  <Input
                    :modelValue="p.organization ?? ''"
                    :aria-label="`${p.name} ${t('settings.organization')}`"
                    @update:modelValue="updateField(p, 'organization', $event || null)"
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
                      class="max-w-[8rem]"
                      :aria-label="`${p.name} ${t('settings.temperature')}`"
                      :modelValue="String(p.temperature)"
                      @update:modelValue="updateField(p, 'temperature', Number($event) || 0)"
                    />
                    <span class="text-xs text-muted-foreground">
                      {{ t('settings.temperatureHelp') }}
                    </span>
                  </div>
                </div>
              </div>

              <!-- Models catalog -->
              <div class="rounded-md border border-border bg-background/40 p-3">
                <div class="mb-2 flex items-center gap-2">
                  <GripVertical class="h-3 w-3 text-muted-foreground" />
                  <span class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {{ t('settings.models') }}
                  </span>
                  <span class="text-[10px] text-muted-foreground">
                    {{ modelsByProvider[p.id]?.length ?? 0 }}
                  </span>
                </div>
                <ul v-if="modelsByProvider[p.id]?.length" class="mb-2 space-y-1">
                  <li
                    v-for="m in modelsByProvider[p.id]"
                    :key="m.id"
                    class="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-accent"
                  >
                    <button
                      class="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border"
                      :class="p.model === m.id ? 'border-primary bg-primary' : 'border-border'"
                      :aria-label="p.model === m.id ? t('settings.modelActive') : t('settings.modelPick')"
                      @click="pickModel(p.id, m.id)"
                    >
                      <span v-if="p.model === m.id" class="h-1.5 w-1.5 rounded-full bg-primary-foreground" />
                    </button>
                    <span class="font-mono">{{ m.id }}</span>
                    <span v-if="m.label && m.label !== m.id" class="text-muted-foreground">
                      — {{ m.label }}
                    </span>
                    <span v-if="p.model === m.id" class="ml-auto text-[10px] uppercase tracking-wider text-primary">
                      {{ t('settings.modelActive') }}
                    </span>
                    <button
                      class="ml-auto rounded p-1 text-muted-foreground hover:bg-background hover:text-destructive"
                      :aria-label="t('common.delete')"
                      @click="removeModel(p.id, m.id)"
                    >
                      <X class="h-3 w-3" />
                    </button>
                  </li>
                </ul>
                <div class="flex gap-2">
                  <Input
                    class="flex-1"
                    :modelValue="draftModelInput[p.id] ?? ''"
                    @update:modelValue="updateModelInput(p.id, $event)"
                    :placeholder="t('settings.addModelPlaceholder')"
                    @keydown.enter.prevent="addModel(p.id)"
                  />
                  <Button size="sm" variant="outline" @click="addModel(p.id)">
                    <Plus class="h-3 w-3" /> {{ t('settings.addModel') }}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <button
              class="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent"
              :aria-label="addOpen ? t('settings.collapse') : t('settings.expand')"
              @click="addOpen = !addOpen"
            >
              <component :is="addOpen ? ChevronDown : ChevronRight" class="h-4 w-4" />
            </button>
            <Plus class="h-4 w-4" /> {{ t('settings.addProvider') }}
          </CardTitle>
          <CardDescription>
            {{ t('settings.addProviderDesc') }}
          </CardDescription>
        </CardHeader>
        <CardContent v-if="addOpen" class="space-y-3">
          <div class="grid gap-3 md:grid-cols-2">
            <div>
              <Label class="mb-1 block text-xs">{{ t('settings.name') }}</Label>
              <Input v-model="newDraft.name" :placeholder="t('settings.namePlaceholder')" />
            </div>
            <div>
              <Label class="mb-1 block text-xs">{{ t('settings.apiFormat') }}</Label>
              <Select
                :modelValue="newDraft.api_format"
                :options="formatOptions.map(o => ({ label: `${o.label} (${o.endpoint})`, value: o.value }))"
                @update:modelValue="newDraft.api_format = $event as ApiFormat"
              />
            </div>
            <div class="md:col-span-2">
              <Label class="mb-1 block text-xs">{{ t('settings.baseUrl') }}</Label>
              <Input v-model="newDraft.base_url" :placeholder="t('settings.baseUrlPlaceholder')" />
            </div>
            <div>
              <Label class="mb-1 block text-xs">{{ t('settings.apiKey') }}</Label>
              <Input type="password" v-model="newDraft.api_key" placeholder="sk-…" />
            </div>
            <div>
              <Label class="mb-1 block text-xs">{{ t('settings.organization') }}</Label>
              <Input v-model="newDraft.organization" placeholder="org-…" />
            </div>
            <div>
              <Label class="mb-1 block text-xs">{{ t('settings.firstModel') }}</Label>
              <Input v-model="newDraft.model" :placeholder="t('settings.firstModelPlaceholder')" />
            </div>
            <div>
              <Label class="mb-1 block text-xs">{{ t('settings.temperature') }}</Label>
              <Input
                type="number"
                step="0.05"
                min="0"
                max="2"
                class="max-w-[8rem]"
                v-model="newDraft.temperature"
              />
            </div>
          </div>
          <div class="flex justify-end">
            <Button @click="saveNew">
              <Save class="h-4 w-4" /> {{ t('settings.saveProvider') }}
            </Button>
          </div>
          <div class="rounded-md border border-amber-500/30 bg-amber-100 p-3 text-xs text-amber-900 dark:bg-amber-500/20 dark:text-amber-200">
            <AlertTriangle class="mr-1 inline h-3 w-3" />
            {{ t('settings.apiKeyHint') }}
          </div>
          <!-- Credential store unreachable: keys fall back to the settings
               file, which the user must know about or they will assume the
               key is protected. -->
          <div
            v-if="llm.secretStoreError"
            role="alert"
            class="rounded-md border border-red-500/40 bg-red-100 p-3 text-xs text-red-900 dark:bg-red-500/20 dark:text-red-200"
          >
            <AlertTriangle class="mr-1 inline h-3 w-3" />
            {{ t('settings.secretStoreError') }}
            <code class="font-mono">{{ llm.secretStoreError }}</code>
          </div>
        </CardContent>
      </Card>
    </div>
  </div>
</template>