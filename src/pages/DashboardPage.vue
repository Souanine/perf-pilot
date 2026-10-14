<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useAppStore } from "@/stores/app";
import { useScriptsStore } from "@/stores/scripts";
import { useRunsStore } from "@/stores/runs";
import { useLLMStore } from "@/stores/llm";
import Card from "@/components/ui/Card.vue";
import CardHeader from "@/components/ui/CardHeader.vue";
import CardTitle from "@/components/ui/CardTitle.vue";
import CardDescription from "@/components/ui/CardDescription.vue";
import CardContent from "@/components/ui/CardContent.vue";
import Button from "@/components/ui/Button.vue";
import Badge from "@/components/ui/Badge.vue";
import Sparkline from "@/components/Sparkline.vue";
import {
  Activity,
  FileCode2,
  Sparkles,
  Settings,
  CheckCircle2,
  XCircle,
  Cpu,
  Globe,
  FlaskConical,
} from "@lucide/vue";
import { relativeTime } from "@/lib/utils";

const router = useRouter();
const { t } = useI18n();
const app = useAppStore();
const scripts = useScriptsStore();
const runs = useRunsStore();
const llm = useLLMStore();

const recentRuns = computed(() => runs.history.slice(0, 5));
const passedCount = computed(() => runs.history.filter((r) => r.status === "passed").length);
const failedCount = computed(() => runs.history.filter((r) => r.status === "failed" || r.status === "errored").length);
const liveCount = computed(() => runs.running.length);
const llmConfigured = computed(() =>
  llm.providers.some(
    (p) =>
      p.api_key &&
      p.api_key.length > 0 &&
      !(p.api_format === "chat_completions" && p.base_url.includes("localhost:11434")),
  ),
);

// Reverse so the sparkline reads oldest → newest (matches left-to-right
// time intuition). Cap at the most recent 20 runs so the chart stays
// readable; older runs compress into a thin tail.
const p95Series = computed(() =>
  [...runs.history].reverse().slice(-20).map((r) => r.p95_ms ?? null),
);
const rpsSeries = computed(() =>
  [...runs.history].reverse().slice(-20).map((r) => r.rps ?? null),
);
const errorSeries = computed(() =>
  [...runs.history].reverse().slice(-20).map((r) => r.error_rate_pct ?? null),
);
const hasChartData = computed(
  () =>
    p95Series.value.some((v) => v !== null) ||
    rpsSeries.value.some((v) => v !== null) ||
    errorSeries.value.some((v) => v !== null),
);
</script>

<template>
  <div class="h-full overflow-auto p-6">
    <div class="mx-auto flex max-w-6xl flex-col gap-6">
      <div class="flex items-end justify-between gap-4">
        <div>
          <h2 class="text-2xl font-bold tracking-tight">{{ t('dashboard.welcome') }}</h2>
          <p class="mt-1 text-sm text-muted-foreground">
            {{ t('dashboard.subtitle') }}
          </p>
        </div>
        <div class="flex gap-2">
          <Button variant="outline" @click="router.push('/ai')">
            <Sparkles class="h-4 w-4" /> {{ t('dashboard.generateAI') }}
          </Button>
          <Button @click="router.push('/editor')">
            <FileCode2 class="h-4 w-4" /> {{ t('dashboard.openEditor') }}
          </Button>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent class="flex items-center gap-3 p-5">
            <div class="grid h-10 w-10 place-items-center rounded-md bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
              <CheckCircle2 class="h-5 w-5" />
            </div>
            <div>
              <div class="text-xs uppercase tracking-wider text-muted-foreground">{{ t('dashboard.cardPassed') }}</div>
              <div class="text-2xl font-semibold">{{ passedCount }}</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent class="flex items-center gap-3 p-5">
            <div class="grid h-10 w-10 place-items-center rounded-md bg-red-500/15 text-red-600">
              <XCircle class="h-5 w-5" />
            </div>
            <div>
              <div class="text-xs uppercase tracking-wider text-muted-foreground">{{ t('dashboard.cardFailed') }}</div>
              <div class="text-2xl font-semibold">{{ failedCount }}</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent class="flex items-center gap-3 p-5">
            <div class="grid h-10 w-10 place-items-center rounded-md bg-sky-500/15 text-sky-600">
              <Activity class="h-5 w-5" />
            </div>
            <div>
              <div class="text-xs uppercase tracking-wider text-muted-foreground">{{ t('dashboard.cardRunning') }}</div>
              <div class="text-2xl font-semibold">{{ liveCount }}</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent class="flex items-center gap-3 p-5">
            <div class="grid h-10 w-10 place-items-center rounded-md bg-violet-500/15 text-violet-600">
              <FileCode2 class="h-5 w-5" />
            </div>
            <div>
              <div class="text-xs uppercase tracking-wider text-muted-foreground">{{ t('dashboard.cardScripts') }}</div>
              <div class="text-2xl font-semibold">{{ scripts.files.length }}</div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card class="lg:col-span-2">
          <CardHeader>
            <CardTitle>{{ t('dashboard.recentRunsTitle') }}</CardTitle>
            <CardDescription>{{ t('dashboard.recentRunsDesc') }}</CardDescription>
          </CardHeader>
          <CardContent class="space-y-2">
            <div v-if="!recentRuns.length" class="text-sm text-muted-foreground">
              {{ t('dashboard.recentRunsEmpty') }}
            </div>
            <button
              v-for="r in recentRuns"
              :key="r.run_id"
              class="flex w-full items-center gap-3 rounded-md border border-border bg-card p-3 text-left text-sm transition-colors hover:bg-accent"
              @click="router.push(`/history?run=${r.run_id}`)"
            >
              <Badge :variant="r.status === 'passed' ? 'success' : r.status === 'running' ? 'info' : 'destructive'">
                {{ r.status }}
              </Badge>
              <span class="font-medium">{{ r.label || r.script_path.split(/[\\/]/).pop() }}</span>
              <span class="ml-auto text-xs text-muted-foreground">{{ relativeTime(r.started_at) }}</span>
            </button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{{ t('dashboard.envTitle') }}</CardTitle>
            <CardDescription>{{ t('dashboard.envDesc') }}</CardDescription>
          </CardHeader>
          <CardContent class="space-y-3 text-sm">
            <div class="flex items-center justify-between">
              <span class="flex items-center gap-2"><Cpu class="h-4 w-4 text-muted-foreground" /> {{ t('dashboard.envK6') }}</span>
              <Badge :variant="app.k6Available ? 'success' : 'destructive'">
                {{ app.k6Available ? t('dashboard.envDetected') : t('dashboard.envNotFound') }}
              </Badge>
            </div>
            <div class="flex items-center justify-between">
              <span class="flex items-center gap-2"><Globe class="h-4 w-4 text-muted-foreground" /> {{ llm.active.name }}</span>
              <Badge :variant="llmConfigured ? 'success' : 'warning'">
                {{ llmConfigured ? t('dashboard.envDetected') : t('dashboard.envNotConfigured') }}
              </Badge>
            </div>
            <div class="flex items-center justify-between">
              <span class="flex items-center gap-2"><FlaskConical class="h-4 w-4 text-muted-foreground" /> {{ t('dashboard.envScriptsDir') }}</span>
              <code class="rounded bg-muted px-2 py-0.5 text-xs">{{ app.info?.scripts_dir || "—" }}</code>
            </div>
            <Button variant="outline" class="mt-2 w-full" @click="router.push('/settings')">
              <Settings class="h-4 w-4" /> {{ t('dashboard.configureLLM') }}
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card v-if="hasChartData">
        <CardHeader>
          <CardTitle>{{ t('dashboard.trendsTitle') }}</CardTitle>
          <CardDescription>{{ t('dashboard.trendsDesc') }}</CardDescription>
        </CardHeader>
        <CardContent>
          <div class="grid grid-cols-1 gap-6 md:grid-cols-3">
            <div class="space-y-1">
              <div class="flex items-baseline justify-between">
                <span class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">p(95) latency</span>
                <span class="text-xs text-muted-foreground">ms</span>
              </div>
              <Sparkline
                :values="p95Series"
                kind="p95"
                :width="320"
                :height="64"
                :label="`p95 latency, ${p95Series.length} runs`"
              />
            </div>
            <div class="space-y-1">
              <div class="flex items-baseline justify-between">
                <span class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Throughput</span>
                <span class="text-xs text-muted-foreground">req/s</span>
              </div>
              <Sparkline
                :values="rpsSeries"
                kind="rps"
                :width="320"
                :height="64"
                :label="`rps, ${rpsSeries.length} runs`"
              />
            </div>
            <div class="space-y-1">
              <div class="flex items-baseline justify-between">
                <span class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Error rate</span>
                <span class="text-xs text-muted-foreground">%</span>
              </div>
              <Sparkline
                :values="errorSeries"
                kind="error"
                :width="320"
                :height="64"
                :label="`error rate, ${errorSeries.length} runs`"
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  </div>
</template>