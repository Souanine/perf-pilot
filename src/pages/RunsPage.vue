<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Play,
  Square,
  Terminal as TerminalIcon,
  Gauge,
  ChevronDown,
  ChevronRight,
  Plus,
} from "lucide-vue-next";
import Button from "@/components/ui/Button.vue";
import Card from "@/components/ui/Card.vue";
import CardContent from "@/components/ui/CardContent.vue";
import CardHeader from "@/components/ui/CardHeader.vue";
import CardTitle from "@/components/ui/CardTitle.vue";
import Input from "@/components/ui/Input.vue";
import Label from "@/components/ui/Label.vue";
import Badge from "@/components/ui/Badge.vue";
import Select from "@/components/ui/Select.vue";
import ScrollArea from "@/components/ui/ScrollArea.vue";
import LiveOutputPane from "@/components/LiveOutputPane.vue";
import { useScriptsStore } from "@/stores/scripts";
import { useRunsStore, type LiveRun } from "@/stores/runs";
import { useAppStore } from "@/stores/app";
import { useToastStore } from "@/stores/toast";
import { formatDuration, relativeTime } from "@/lib/utils";
import { parseEnvLines, shellSplit } from "@/lib/shellSplit";

const scripts = useScriptsStore();
const runs = useRunsStore();
const app = useAppStore();
const toast = useToastStore();
const route = useRoute();
const router = useRouter();
const { t } = useI18n();

const selectedRunId = ref<string | null>(null);
const label = ref<string>("");
const envInput = ref<string>("");
const cliArgs = ref<string>("");
const scriptPath = ref<string>(route.query.script?.toString() ?? "");

const selectedRun = computed(() => {
  const id = selectedRunId.value;
  if (!id) return runs.liveList[0];
  return runs.live[id] ?? runs.liveList.find((r) => r.run_id === id) ?? runs.liveList[0];
});

const scriptOptions = computed(() => [
  { label: "— pick a script —", value: "" },
  ...scripts.files.map((f) => ({ label: f.name, value: f.path })),
]);

const envVars = computed({
  get: () => envInput.value,
  set: (v: string) => (envInput.value = v),
});

function parseEnv(): Record<string, string> {
  // Tokenize via the same shell-aware splitter used by parseCli so
  // `BASE_URL="https://x.com?a=1&b=2"` survives intact. The original
  // naive `split(/\n+/)` would have chopped the value at whitespace
  // inside the URL — silently dropping query params.
  return parseEnvLines(envInput.value);
}

function parseCli(): string[] {
  // Naive `split(/\s+/)` broke quoted args (`--label="a b"`) and any
  // URL with a query string. The shell-aware tokenizer handles
  // single, double, and unterminated quotes gracefully.
  return shellSplit(cliArgs.value);
}

async function startRun() {
  if (!scriptPath.value) {
    toast.push({ title: t('runs.pickScriptFirst'), variant: "warning" });
    return;
  }
  if (!app.k6Available) {
    toast.push({
      title: "k6 binary not found",
      description: "Install k6 and ensure it's on PATH.",
      variant: "destructive",
    });
    return;
  }
  try {
    const id = await runs.start(scriptPath.value, {
      label: label.value || undefined,
      env: parseEnv(),
      cli_args: parseCli(),
    });
    selectedRunId.value = id;
    toast.push({
      title: "Run started",
      description: id,
      variant: "info",
    });
  } catch (e: unknown) {
    toast.push({
      title: "Failed to start run",
      description: e instanceof Error ? e.message : String(e),
      variant: "destructive",
    });
  }
}

async function browseScript() {
  const selected = await openDialog({
    multiple: false,
    filters: [{ name: "JavaScript", extensions: ["js"] }],
  });
  if (typeof selected === "string") {
    scriptPath.value = selected;
    await scripts.refresh();
  }
}

async function stopRun(id: string) {
  await runs.stop(id);
}

function toggleRun(id: string) {
  selectedRunId.value = selectedRunId.value === id ? null : id;
}

function statusBadge(s: string) {
  switch (s) {
    case "passed":
      return "success" as const;
    case "failed":
    case "errored":
      return "destructive" as const;
    case "running":
      return "info" as const;
    case "stopped":
      return "warning" as const;
    default:
      return "secondary" as const;
  }
}

// Reactive tick so running-run elapsed time updates every second while a run is in flight.
// The timer only runs when at least one run is in flight; the `watch` on
// `runs.running` arms and disarms it as work starts and finishes.
const nowMs = ref(Date.now());
let elapsedTimer: ReturnType<typeof setInterval> | null = null;
function startElapsedTimer() {
  if (elapsedTimer) return;
  elapsedTimer = setInterval(() => {
    // Only push updates if we still have a live run; harmless if not,
    // but the early exit keeps the watch arming path simple.
    if (runs.running.length === 0) return;
    nowMs.value = Date.now();
  }, 1000);
}
function stopElapsedTimer() {
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}
watch(
  () => runs.running.length,
  (n) => {
    if (n > 0) startElapsedTimer();
    else stopElapsedTimer();
  },
  { immediate: true },
);
onBeforeUnmount(stopElapsedTimer);

function elapsed(r: LiveRun): string {
  if (!r.started_at) return "—";
  const start = new Date(r.started_at).getTime();
  const end = r.finished_at ? new Date(r.finished_at).getTime() : nowMs.value;
  return formatDuration(end - start);
}

watch(
  () => route.query.script,
  (v) => {
    if (typeof v === "string") scriptPath.value = v;
  },
);

onMounted(async () => {
  await scripts.refresh();
});
</script>

<template>
  <div class="grid h-full grid-cols-[300px_minmax(0,1fr)]">
    <aside class="flex flex-col border-r border-border bg-card/30">
      <div class="border-b border-border p-3">
        <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {{ t('runs.newRun') }}
        </h3>
        <div class="space-y-2">
          <div>
            <Label class="mb-1 block text-xs">{{ t('runs.scriptLabel') }}</Label>
            <div class="flex gap-1">
              <Select
              class="flex-1"
              v-model="scriptPath"
              :options="scriptOptions"
              :aria-label="t('runs.scriptLabel')"
            />
              <Button variant="outline" size="icon" @click="browseScript" :aria-label="t('common.browse')">
                <Plus class="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div>
            <Label class="mb-1 block text-xs">{{ t('runs.labelLabel') }}</Label>
            <Input v-model="label" placeholder="e.g. checkout-smoke" />
          </div>
          <div>
            <Label class="mb-1 block text-xs">{{ t('runs.envLabel') }}</Label>
            <textarea
              v-model="envVars"
              rows="3"
              class="flex min-h-[60px] w-full rounded-md border border-input bg-background px-3 py-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono"
              placeholder="BASE_URL=https://api.example.com&#10;TOKEN=abc123"
            />
          </div>
          <div>
            <Label class="mb-1 block text-xs">{{ t('runs.cliArgsLabel') }}</Label>
            <Input
              v-model="cliArgs"
              placeholder="--summary-trend-stats=p(95) --quiet"
            />
          </div>
          <Button class="w-full" size="sm" @click="startRun" :disabled="!app.k6Available">
            <Play class="h-4 w-4" /> {{ t('runs.startRun') }}
          </Button>
          <div v-if="!app.k6Available" class="text-xs text-destructive">
            k6 binary not found.
          </div>
        </div>
      </div>

      <div class="border-b border-border p-3">
        <h3 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {{ t('runs.liveAndRecent') }}
        </h3>
      </div>
      <ScrollArea class="flex-1">
        <ul class="space-y-0.5 p-2">
          <li v-for="r in runs.liveList" :key="r.run_id">
            <button
              class="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
              :class="selectedRun?.run_id === r.run_id ? 'bg-accent' : ''"
              @click="toggleRun(r.run_id)"
            >
              <component
                :is="selectedRun?.run_id === r.run_id ? ChevronDown : ChevronRight"
                class="h-3 w-3 shrink-0 text-muted-foreground"
              />
              <Badge :variant="statusBadge(r.status)" class="shrink-0">{{ r.status }}</Badge>
              <span class="min-w-0 flex-1 truncate">
                {{ r.options.label || r.script_path.split(/[\\/]/).pop() }}
              </span>
              <span class="text-xs text-muted-foreground">{{ elapsed(r) }}</span>
            </button>
          </li>
          <li v-for="r in runs.history.slice(0, 10)" :key="r.run_id">
            <button
              class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
              @click="router.push(`/history?run=${r.run_id}`)"
            >
              <Badge :variant="statusBadge(r.status)" class="shrink-0">{{ r.status }}</Badge>
              <span class="min-w-0 flex-1 truncate">
                {{ r.label || r.script_path.split(/[\\/]/).pop() }}
              </span>
              <span class="text-xs text-muted-foreground">{{ relativeTime(r.started_at) }}</span>
            </button>
          </li>
          <li v-if="!runs.liveList.length && !runs.history.length" class="px-2 py-3 text-xs text-muted-foreground">
            {{ t('runs.noRunsYet') }}
          </li>
        </ul>
      </ScrollArea>
    </aside>

    <section class="flex min-h-0 flex-col">
      <template v-if="selectedRun">
        <div class="flex items-center gap-2 border-b border-border bg-card/40 px-4 py-2">
          <TerminalIcon class="h-4 w-4 text-primary" />
          <span class="text-sm font-medium">
            {{ selectedRun.options.label || selectedRun.script_path.split(/[\\/]/).pop() }}
          </span>
          <Badge :variant="statusBadge(selectedRun.status)">{{ selectedRun.status }}</Badge>
          <span class="text-xs text-muted-foreground">{{ elapsed(selectedRun) }}</span>
          <div class="ml-auto flex gap-2">
            <Button
              v-if="selectedRun.status === 'running'"
              variant="destructive"
              size="sm"
              @click="stopRun(selectedRun.run_id)"
            >
              <Square class="h-3 w-3" /> Stop
            </Button>
          </div>
        </div>

        <div class="grid grid-rows-[auto_minmax(0,1fr)] gap-3 p-3">
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardContent class="p-3">
                <div class="text-[10px] uppercase tracking-wider text-muted-foreground">Command</div>
                <code class="mt-1 block break-all font-mono text-xs">
                  {{ selectedRun.command.join(' ') }}
                </code>
              </CardContent>
            </Card>
            <Card>
              <CardContent class="p-3">
                <div class="text-[10px] uppercase tracking-wider text-muted-foreground">Metrics</div>
                <div class="mt-1 grid grid-cols-1 gap-0.5 font-mono text-xs">
                  <div v-for="(v, k) in selectedRun.metrics" :key="k" class="flex justify-between">
                    <span class="text-muted-foreground">{{ k }}</span>
                    <span>{{ v }}</span>
                  </div>
                  <div v-if="!Object.keys(selectedRun.metrics).length" class="text-muted-foreground">
                    {{ t('runs.waitingForOutput') }}
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent class="p-3">
                <div class="text-[10px] uppercase tracking-wider text-muted-foreground">Started</div>
                <div class="text-sm">{{ new Date(selectedRun.started_at).toLocaleTimeString() }}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent class="p-3">
                <div class="text-[10px] uppercase tracking-wider text-muted-foreground">Exit</div>
                <div class="text-sm">
                  {{ selectedRun.exit_code !== null ? selectedRun.exit_code : (selectedRun.status === 'running' ? '…' : '—') }}
                </div>
              </CardContent>
            </Card>
          </div>

          <Card class="min-h-0">
            <CardHeader class="border-b border-border py-2">
              <CardTitle class="flex items-center gap-2 text-sm">
                <TerminalIcon class="h-4 w-4" /> {{ t('runs.output') }}
              </CardTitle>
            </CardHeader>
            <CardContent class="p-0">
              <div class="grid h-[420px] grid-rows-2 divide-y divide-border">
                <LiveOutputPane
                  :lines="selectedRun.stdout_lines"
                  tone="stdout"
                  :placeholder="t('runs.waitingForOutput')"
                />
                <LiveOutputPane
                  :lines="selectedRun.stderr_lines"
                  tone="stderr"
                  :placeholder="t('common.noErrors')"
                />
              </div>
            </CardContent>
          </Card>
        </div>
      </template>
      <template v-else>
        <div class="grid h-full place-items-center text-muted-foreground">
          <Card>
            <CardContent class="flex flex-col items-center gap-3 p-8 text-center">
              <Gauge class="h-8 w-8 text-muted-foreground" />
              <div>{{ t('runs.pickScriptToSeeLive') }}</div>
            </CardContent>
          </Card>
        </div>
      </template>
    </section>
  </div>
</template>