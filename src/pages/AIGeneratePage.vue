<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  Sparkles,
  Loader2,
  Save,
  Play,
  Zap,
  ArrowRight,
  Bot,
  CheckCircle2,
  AlertTriangle,
  Settings,
  History,
  Eraser,
} from "@lucide/vue";
import MonacoEditor from "@/components/MonacoEditor.vue";
import Button from "@/components/ui/Button.vue";
import Card from "@/components/ui/Card.vue";
import CardHeader from "@/components/ui/CardHeader.vue";
import CardTitle from "@/components/ui/CardTitle.vue";
import CardDescription from "@/components/ui/CardDescription.vue";
import CardContent from "@/components/ui/CardContent.vue";
import Textarea from "@/components/ui/Textarea.vue";
import Input from "@/components/ui/Input.vue";
import Label from "@/components/ui/Label.vue";
import Badge from "@/components/ui/Badge.vue";
import Select from "@/components/ui/Select.vue";
import { useLLMStore } from "@/stores/llm";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
import { useToastStore } from "@/stores/toast";
import { useAppStore } from "@/stores/app";
import { api, type LlmProviderConfig, type ScriptGenResponse, type ChatMessage } from "@/lib/tauri";
import {
  newStreamRequestId,
  startLlmStream,
} from "@/composables/useLlmStream";

const llm = useLLMStore();
const scripts = useScriptsStore();
const ui = useUiStore();
const app = useAppStore();
const toast = useToastStore();
const router = useRouter();
const { t } = useI18n();

const prompt = ref(
  "Stress test the JSON placeholder API: GET /posts 50 times, then POST /posts with a JSON body. 50 VUs for 30s, ramping from 0 to 50 over 10s.",
);
const hint = ref("Use a ramping-vus executor and add thresholds: p95 < 300ms, error rate < 1%.");
const baseUrl = ref("https://jsonplaceholder.typicode.com");
const generating = ref(false);
const result = ref<ScriptGenResponse | null>(null);
const testStatus = ref<"idle" | "testing" | "ok" | "failed">("idle");
const lastError = ref<string | null>(null);
const placeholderScript =
  "// Your generated k6 script will appear here.\n" +
  '// Click "Generate k6 script" to start.';
const history = ref<ChatMessage[]>([]);
const refinement = ref("");
const refining = ref(false);
const tokenTotals = ref<{ in: number; out: number }>({ in: 0, out: 0 });

const iterationCount = computed(() => Math.max(0, history.value.filter((m) => m.role === "user").length));

const activeProvider = computed<LlmProviderConfig>(() => llm.active);

const modelOptions = computed(() =>
  activeProvider.value.models.map((m) => ({
    label: m.label && m.label !== m.id ? `${m.label} (${m.id})` : m.id,
    value: m.id,
  })),
);

const formatEndpoint: Record<string, string> = {
  chat_completions: "/chat/completions",
  anthropic_messages: "/v1/messages",
  responses: "/responses",
};

const formatLabel: Record<string, string> = {
  chat_completions: "OpenAI Chat Completions",
  anthropic_messages: "Anthropic Messages",
  responses: "OpenAI Responses",
};

// If the active provider changes (or the catalog is edited), and the
// current `provider.model` no longer matches any catalog entry, snap it
// back to the first model. Avoids stale selections after edits in
// Settings.
watch(
  () => activeProvider.value.models.map((m) => m.id),
  (ids) => {
    if (ids.length === 0) return;
    if (!ids.includes(activeProvider.value.model)) {
      llm.setActiveModel(ids[0]);
    }
  },
);

async function generate() {
  if (!activeProvider.value.model) {
    toast.push({
      title: t('ai.pickModel'),
      description: t('ai.configureProviders'),
      variant: "warning",
    });
    return;
  }
  if (!prompt.value.trim()) {
    toast.push({ title: t('ai.promptEmpty'), variant: "warning" });
    return;
  }
  generating.value = true;
  lastError.value = null;
  // Reset history if this is a brand-new generation (no prior script).
  if (!result.value) {
    history.value = [];
    tokenTotals.value = { in: 0, out: 0 };
  }
  history.value.push({ role: "user", content: prompt.value });

  // Subscribe to the chunk stream BEFORE firing the IPC so we never lose
  // the first delta. The composable dedupes if a previous subscription
  // already exists.
  const requestId = newStreamRequestId();
  let assembled = "";
  let streamModel = activeProvider.value.model;
  const controller = await startLlmStream(requestId, (chunk) => {
    assembled += chunk;
    // Mirror the streamed script into the Monaco editor live. We keep the
    // existing `result.value` if any so model/explanation aren't wiped on
    // every chunk.
    const prev = result.value;
    result.value = {
      script: assembled,
      explanation: prev?.explanation ?? null,
      model: prev?.model ?? streamModel,
      tokens_in: prev?.tokens_in ?? null,
      tokens_out: prev?.tokens_out ?? null,
    };
  });

  try {
    const r = await api.generateScriptStream(
      requestId,
      activeProvider.value,
      {
        prompt: prompt.value,
        hint: hint.value,
        base_url: baseUrl.value || undefined,
      },
      history.value.slice(0, -1),
    );
    history.value.push({ role: "assistant", content: r.script });
    result.value = r;
    tokenTotals.value.in += r.tokens_in ?? 0;
    tokenTotals.value.out += r.tokens_out ?? 0;
    toast.push({
      title: t('ai.saved'),
      description: `${r.tokens_in ?? "?"} in / ${r.tokens_out ?? "?"} out`,
      variant: "success",
    });
  } catch (e: unknown) {
    lastError.value = e instanceof Error ? e.message : String(e);
    toast.push({
      title: t('ai.errorGenerate'),
      description: lastError.value ?? undefined,
      variant: "destructive",
    });
  } finally {
    controller.cancel();
    generating.value = false;
  }
}

async function refine() {
  if (!refinement.value.trim()) return;
  if (!result.value) {
    toast.push({
      title: "Generate a script first",
      description: "Refine works on top of a previous generation.",
      variant: "warning",
    });
    return;
  }
  refining.value = true;
  lastError.value = null;
  history.value.push({ role: "user", content: refinement.value });

  const requestId = newStreamRequestId();
  let assembled = "";
  const controller = await startLlmStream(requestId, (chunk) => {
    assembled += chunk;
    const prev = result.value;
    result.value = {
      script: assembled,
      explanation: prev?.explanation ?? null,
      model: prev?.model ?? activeProvider.value.model,
      tokens_in: prev?.tokens_in ?? null,
      tokens_out: prev?.tokens_out ?? null,
    };
  });

  try {
    const r = await api.generateScriptStream(
      requestId,
      activeProvider.value,
      { prompt: refinement.value, hint: "", base_url: baseUrl.value || undefined },
      history.value.slice(0, -1),
    );
    history.value.push({ role: "assistant", content: r.script });
    result.value = r;
    tokenTotals.value.in += r.tokens_in ?? 0;
    tokenTotals.value.out += r.tokens_out ?? 0;
    refinement.value = "";
    toast.push({
      title: "Refined",
      description: `${tokenTotals.value.in}/${tokenTotals.value.out} total tokens`,
      variant: "success",
    });
  } catch (e: unknown) {
    lastError.value = e instanceof Error ? e.message : String(e);
    toast.push({
      title: t('ai.errorGenerate'),
      description: lastError.value ?? undefined,
      variant: "destructive",
    });
  } finally {
    controller.cancel();
    refining.value = false;
  }
}

function clearConversation() {
  history.value = [];
  result.value = null;
  tokenTotals.value = { in: 0, out: 0 };
  refinement.value = "";
  toast.push({ title: t('common.reset') + ' ✓', variant: "info", timeout: 1500 });
}

async function testConnection() {
  testStatus.value = "testing";
  try {
    const r = await api.testLlm(activeProvider.value);
    testStatus.value = r.ok ? "ok" : "failed";
    toast.push({
      title: r.ok ? t('status.passed') : t('status.errored'),
      description: r.message,
      variant: r.ok ? "success" : "destructive",
    });
  } catch (e: unknown) {
    testStatus.value = "failed";
    toast.push({
      title: "Test failed",
      description: e instanceof Error ? e.message : String(e),
      variant: "destructive",
    });
  }
}

/** Default Save-As path inside the app's scripts_dir, so the new file
 *  is always picked up by the Runs page and the History list. */
function generatedFileName(): string {
  return `generated-${Date.now()}.js`;
}

async function saveGenerated() {
  if (!result.value?.script) return;
  const base = app.info?.scripts_dir || "";
  const defaultPath = base ? `${base}/${generatedFileName()}` : generatedFileName();
  const target = await saveDialog({
    defaultPath,
    filters: [{ name: "JavaScript", extensions: ["js"] }],
  });
  if (!target) return;
  await scripts.saveAs(target, result.value.script);
    toast.push({ title: t('ai.savedToast'), description: target, variant: "success" });
}

async function runGenerated() {
  if (!result.value?.script) return;
  const base = app.info?.scripts_dir || "";
  const defaultPath = base ? `${base}/${generatedFileName()}` : generatedFileName();
  const target = await saveDialog({
    defaultPath,
    filters: [{ name: "JavaScript", extensions: ["js"] }],
  });
  if (!target) return;
  await scripts.saveAs(target, result.value.script);
  await router.push({ path: "/runs", query: { script: target } });
  // The Runs page reads ?script=… but the Runs page reads scripts.files
  // asynchronously; the watch in RunsPage picks it up via route.query and
  // sets scriptPath — wait a tick before re-reading the dropdown.
  await new Promise((r) => setTimeout(r, 100));
  // The script id may need to be re-resolved to the absolute path.
}

/** Silently save the generated script to scripts_dir (overwriting any same-named
 *  file from a previous generation) and navigate straight to the Runs page
 *  with the script pre-selected. Skips the OS save dialog. */
async function runInPlace() {
  if (!result.value?.script) return;
  const base = app.info?.scripts_dir;
  if (!base) {
    toast.push({
      title: t('ai.appDataMissing'),
      description: t('ai.noDataDir'),
      variant: "warning",
    });
    return;
  }
  const target = `${base}/generated-latest.js`;
  await scripts.saveAs(target, result.value.script);
  toast.push({
    title: t('ai.runningLatest'),
    description: target,
    variant: "success",
    timeout: 2000,
  });
  await router.push({ path: "/runs", query: { script: target } });
}

function fillExample(kind: string) {
  switch (kind) {
    case "smoke":
      prompt.value =
        "Smoke test the homepage of my staging site. GET /, GET /api/health. 5 VUs, 30s duration.";
      baseUrl.value = "https://staging.example.com";
      hint.value = "Use constant-vus executor. Add thresholds: p95 < 800ms, error rate < 1%.";
      break;
    case "spike":
      prompt.value =
        "Spike test: ramp from 0 to 200 VUs in 5s, hold for 30s, ramp down to 0 in 5s.";
      baseUrl.value = "https://api.example.com";
      hint.value = "Use ramping-vus with start/middle/end stages. Add thresholds and 1 check per request.";
      break;
    case "api":
      prompt.value =
        "Mixed API scenario: 70% GET /products, 20% GET /products/:id, 10% POST /cart. Each VU holds a Bearer token from __ENV.TOKEN.";
      baseUrl.value = "https://api.example.com";
      hint.value = "Use scenarios per endpoint with different weights. Include 90th/95th percentile thresholds.";
      break;
  }
}
</script>

<template>
  <div class="grid h-full grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
    <!-- LEFT: prompt + provider -->
    <section class="flex min-h-0 flex-col gap-3 overflow-auto border-r border-border p-4">
      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <Sparkles class="h-4 w-4 text-primary" />
            {{ t('ai.title') }}
          </CardTitle>
          <CardDescription>
            {{ t('ai.subtitle') }}
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-3">
          <div class="grid gap-2">
            <div class="flex items-center justify-between">
              <Label>{{ t('ai.providerLabel') }}</Label>
              <Button
                variant="ghost"
                size="sm"
                @click="router.push('/settings')"
                aria-label="Configure providers"
              >
                <Settings class="h-3 w-3" /> {{ t('ai.configureProviders') }}
              </Button>
            </div>
            <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span class="font-medium text-foreground">{{ activeProvider.name || t('ai.noModel') }}</span>
              <span>·</span>
              <code class="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground">
                {{ formatLabel[activeProvider.api_format] }} · {{ formatEndpoint[activeProvider.api_format] }}
              </code>
              <span>·</span>
              <span class="truncate">{{ activeProvider.base_url || '—' }}</span>
              <span v-if="!activeProvider.api_key && activeProvider.base_url !== 'http://localhost:11434/v1'" class="ml-auto">
                <Badge variant="warning">{{ t('ai.noApiKey') }}</Badge>
              </span>
            </div>
          </div>

          <div class="grid gap-2">
            <Label>{{ t('ai.modelLabel') }}</Label>
            <div class="flex gap-2">
              <Select
                class="flex-1"
                :modelValue="activeProvider.model"
                :options="modelOptions"
                :disabled="modelOptions.length === 0"
                :aria-label="t('ai.modelLabel')"
                @update:modelValue="llm.setActiveModel($event)"
              />
            </div>
            <p v-if="modelOptions.length === 0" class="text-xs text-muted-foreground">
              {{ t('ai.noModelsHint') }}
            </p>
          </div>

          <Button variant="outline" size="sm" @click="testConnection" :disabled="testStatus === 'testing'">
            <Loader2 v-if="testStatus === 'testing'" class="h-3 w-3 animate-spin" />
            <CheckCircle2 v-else-if="testStatus === 'ok'" class="h-3 w-3 text-emerald-500" />
            <AlertTriangle v-else-if="testStatus === 'failed'" class="h-3 w-3 text-red-500" />
            {{ t('ai.testConnection') }}
          </Button>

          <div class="grid gap-2">
            <Label>{{ t('ai.targetBaseUrl') }}</Label>
            <Input v-model="baseUrl" placeholder="https://api.example.com" />
          </div>

          <div class="grid gap-2">
            <Label>{{ t('ai.prompt') }}</Label>
            <Textarea v-model="prompt" :rows="6" placeholder="Describe your load test…" />
            <div class="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" @click="fillExample('smoke')">{{ t('ai.exampleSmoke') }}</Button>
            <Button variant="outline" size="sm" @click="fillExample('spike')">{{ t('ai.exampleSpike') }}</Button>
            <Button variant="outline" size="sm" @click="fillExample('api')">{{ t('ai.exampleApi') }}</Button>
            </div>
          </div>

          <div class="grid gap-2">
            <Label>{{ t('ai.hints') }}</Label>
            <Textarea v-model="hint" :rows="3" placeholder="e.g. ramping-vus, p95<300ms" />
          </div>

          <Button class="w-full" size="lg" @click="generate" :disabled="generating">
            <Loader2 v-if="generating" class="h-4 w-4 animate-spin" />
            <Sparkles v-else class="h-4 w-4" />
            {{ generating ? t('common.generating') : t('ai.generate') }}
          </Button>

          <div v-if="lastError" class="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
            {{ lastError }}
          </div>
        </CardContent>
      </Card>
    </section>

    <!-- RIGHT: result preview -->
    <section class="flex min-h-0 flex-col">
      <div class="flex items-center gap-2 border-b border-border bg-card/40 px-4 py-2">
        <Bot class="h-4 w-4 text-primary" />
        <span class="text-sm font-medium">{{ t('ai.ready') }}</span>
        <span v-if="result" class="text-xs text-muted-foreground">
          {{ t('ai.model') }}: {{ result.model }}
        </span>
        <Badge v-if="result" variant="info" class="ml-2">
          <History class="mr-1 h-3 w-3" />
          iter {{ iterationCount }} · {{ tokenTotals.in }}/{{ tokenTotals.out }} tok
        </Badge>
        <div class="ml-auto flex gap-2">
          <Button variant="ghost" size="sm" @click="clearConversation" :disabled="!result">
            <Eraser class="h-3 w-3" /> {{ t('common.reset') }}
          </Button>
          <Button variant="outline" size="sm" @click="saveGenerated" :disabled="!result?.script">
            <Save class="h-3 w-3" /> {{ t('common.save') }}
          </Button>
          <Button variant="outline" size="sm" @click="runInPlace" :disabled="!result?.script" :title="t('ai.runInPlaceTitle')">
            <Zap class="h-3 w-3" /> {{ t('ai.runLatest') }}
          </Button>
          <Button size="sm" @click="runGenerated" :disabled="!result?.script">
            <Play class="h-3 w-3" /> {{ t('common.saveAs') }} & {{ t('common.run') }} <ArrowRight class="h-3 w-3" />
          </Button>
        </div>
      </div>
      <div class="min-h-0 flex-1">
        <MonacoEditor
          :modelValue="result?.script ?? placeholderScript"
          language="javascript"
          :theme="ui.theme === 'dark' ? 'vs-dark' : 'vs'"
          :readOnly="false"
        />
      </div>
      <div class="border-t border-border bg-card/40 p-3">
        <div class="mb-2 flex items-center gap-2">
          <Sparkles class="h-3.5 w-3.5 text-primary" />
          <span class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {{ t('ai.refineHeading') }}
          </span>
          <span class="text-[10px] text-muted-foreground">
            {{ t('ai.refineHelp') }}
          </span>
        </div>
          <Textarea
            v-model="refinement"
            :rows="2"
            :placeholder="t('ai.refinePlaceholder')"
            @keydown.meta.enter.prevent="refine"
            @keydown.ctrl.enter.prevent="refine"
          />
        <div class="mt-2 flex items-center gap-2">
          <Button size="sm" :disabled="!result || refining || !refinement.trim()" @click="refine">
            <Loader2 v-if="refining" class="h-3 w-3 animate-spin" />
            <Sparkles v-else class="h-3 w-3" />
            {{ t('ai.refineButton') }}
          </Button>
          <span class="text-[10px] text-muted-foreground">⌘/Ctrl + Enter</span>
        </div>
      </div>
      <div v-if="result?.explanation" class="border-t border-border bg-card/40 p-3 text-xs text-muted-foreground">
        <div class="mb-1 font-semibold text-foreground">{{ t('ai.explanation') }}</div>
        <div class="whitespace-pre-wrap">{{ result.explanation }}</div>
      </div>
    </section>
  </div>
</template>