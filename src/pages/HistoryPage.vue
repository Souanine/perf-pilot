<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ask as askDialog } from "@tauri-apps/plugin-dialog";
import type { RunOutput } from "@/lib/tauri";
import Card from "@/components/ui/Card.vue";
import CardContent from "@/components/ui/CardContent.vue";
import CardHeader from "@/components/ui/CardHeader.vue";
import CardTitle from "@/components/ui/CardTitle.vue";
import Badge from "@/components/ui/Badge.vue";
import Button from "@/components/ui/Button.vue";
import ScrollArea from "@/components/ui/ScrollArea.vue";
import Input from "@/components/ui/Input.vue";
import { useRunsStore } from "@/stores/runs";
import { useToastStore } from "@/stores/toast";
import { formatDuration, relativeTime, runToMarkdown } from "@/lib/utils";
import { Search, ListChecks, AlertCircle, Clock, Download, Trash2 } from "lucide-vue-next";

const runs = useRunsStore();
const route = useRoute();
const toast = useToastStore();
const { t } = useI18n();

const filter = ref("");
const detail = ref<RunOutput | null>(null);
const selectedId = ref<string | null>(route.query.run?.toString() ?? null);

const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return runs.history;
  return runs.history.filter(
    (r) =>
      r.run_id.includes(q) ||
      (r.label ?? "").toLowerCase().includes(q) ||
      r.script_path.toLowerCase().includes(q) ||
      r.status.includes(q),
  );
});

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

async function loadDetail(id: string) {
  selectedId.value = id;
  detail.value = await runs.loadDetail(id);
}

watch(
  () => route.query.run,
  async (v) => {
    if (typeof v === "string" && v) {
      await loadDetail(v);
    }
  },
  { immediate: true },
);

watch(filtered, async (list) => {
  if (!selectedId.value && list.length) {
    await loadDetail(list[0].run_id);
  }
});

function durationOf(r: RunOutput | null): string {
  if (!r) return "—";
  const start = new Date(r.started_at).getTime();
  const end = r.finished_at ? new Date(r.finished_at).getTime() : Date.now();
  return formatDuration(end - start);
}

async function exportMarkdown() {
  if (!detail.value) return;
  const label = detail.value.label || detail.value.script_path.split(/[\\/]/).pop() || "run";
  const safeName = label.replace(/[\\/:*?"<>|]/g, "_");
  const target = await saveDialog({
    defaultPath: `perf-pilot-${safeName}-${detail.value.run_id}.md`,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (!target) return;
  try {
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(target, runToMarkdown(detail.value));
    toast.push({ title: t('history.export'), description: target, variant: "success" });
  } catch (e: unknown) {
    toast.push({
      title: t('history.export') + ' failed',
      description: e instanceof Error ? e.message : String(e),
      variant: "destructive",
    });
  }
}

async function confirmDelete() {
  if (!detail.value) return;
  const yes = await askDialog(
    t('history.confirmDeleteMessage', { run_id: detail.value.run_id }),
    { title: t('history.confirmDeleteTitle'), kind: "warning" },
  );
  if (!yes) return;
  const removedId = detail.value.run_id;
  await runs.removeRun(removedId);
  detail.value = null;
  selectedId.value = null;
  // Auto-pick the first remaining run if any
  if (filtered.value.length) {
    await loadDetail(filtered.value[0].run_id);
  }
  toast.push({ title: "Run deleted", description: removedId, variant: "warning" });
}

onMounted(async () => {
  await runs.refreshHistory();
  if (selectedId.value && !detail.value) {
    await loadDetail(selectedId.value);
  } else if (!selectedId.value && filtered.value.length) {
    await loadDetail(filtered.value[0].run_id);
  }
});
</script>

<template>
  <div class="grid h-full grid-cols-[320px_minmax(0,1fr)]">
    <aside class="flex flex-col border-r border-border bg-card/30">
      <div class="border-b border-border p-3">
        <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {{ t('history.runHistory') }}
        </h3>
        <div class="relative">
          <Search class="pointer-events-none absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input v-model="filter" class="pl-8" :placeholder="t('history.searchPlaceholder')" />
        </div>
      </div>
      <ScrollArea class="flex-1">
        <ul class="space-y-0.5 p-2">
          <li v-for="r in filtered" :key="r.run_id">
            <button
              class="flex w-full flex-col gap-1 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-accent"
              :class="selectedId === r.run_id ? 'bg-accent' : ''"
              @click="loadDetail(r.run_id)"
            >
              <div class="flex items-center gap-2">
                <Badge :variant="statusBadge(r.status)">{{ r.status }}</Badge>
                <span class="min-w-0 flex-1 truncate font-medium">
                  {{ r.label || r.script_path.split(/[\\/]/).pop() }}
                </span>
              </div>
              <div class="flex items-center gap-2 text-xs text-muted-foreground">
                <Clock class="h-3 w-3" />
                {{ relativeTime(r.started_at) }}
              </div>
            </button>
          </li>
          <li v-if="!filtered.length" class="px-2 py-3 text-xs text-muted-foreground">
            {{ t('history.noMatch') }}
          </li>
        </ul>
      </ScrollArea>
    </aside>

    <section class="flex min-h-0 flex-col overflow-auto p-4">
      <template v-if="detail">
        <div class="mb-4 flex flex-wrap items-center gap-3">
          <Badge :variant="statusBadge(detail.status)">{{ detail.status }}</Badge>
          <h2 class="text-lg font-semibold">
            {{ detail.label || detail.script_path.split(/[\\/]/).pop() }}
          </h2>
          <span class="text-xs text-muted-foreground">id {{ detail.run_id }}</span>
          <span class="text-xs text-muted-foreground">
            {{ durationOf(detail) }}
          </span>
          <div class="ml-auto flex gap-2">
            <Button variant="outline" size="sm" @click="exportMarkdown">
              <Download class="h-3 w-3" /> {{ t('history.export') }}
            </Button>
            <Button variant="ghost" size="sm" class="text-destructive" @click="confirmDelete">
              <Trash2 class="h-3 w-3" /> {{ t('history.delete') }}
            </Button>
          </div>
        </div>

        <Card v-if="detail.error" class="mb-3 border-destructive/40 bg-destructive/5">
          <CardContent class="flex items-start gap-2 p-3 text-sm text-destructive">
            <AlertCircle class="mt-0.5 h-4 w-4" />
            <div class="whitespace-pre-wrap">{{ detail.error }}</div>
          </CardContent>
        </Card>

        <Card class="mb-3">
          <CardHeader class="border-b border-border py-3">
            <CardTitle class="flex items-center gap-2 text-base">
              <ListChecks class="h-4 w-4" /> {{ t('history.summaryMetrics') }}
            </CardTitle>
          </CardHeader>
          <CardContent class="p-0">
            <div v-if="detail.metrics.length" class="grid grid-cols-1 divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0 md:grid-cols-3">
              <div v-for="m in detail.metrics" :key="m.name" class="p-3">
                <div class="text-xs uppercase tracking-wider text-muted-foreground">{{ m.name }}</div>
                <div class="mt-1 font-mono text-sm">{{ m.value }}</div>
              </div>
            </div>
            <div v-else class="p-4 text-sm text-muted-foreground">
              {{ t('history.noMetrics') }}
            </div>
          </CardContent>
        </Card>

        <Card class="mb-3">
          <CardHeader class="border-b border-border py-3">
            <CardTitle class="text-base">{{ t('history.stdout') }}</CardTitle>
          </CardHeader>
          <CardContent class="p-0">
            <ScrollArea class="max-h-[420px] bg-black/95 p-3 font-mono text-xs leading-relaxed text-emerald-100">
              <pre>{{ detail.stdout || t('common.empty') }}</pre>
            </ScrollArea>
          </CardContent>
        </Card>

        <Card>
          <CardHeader class="border-b border-border py-3">
            <CardTitle class="text-base">{{ t('history.stderr') }}</CardTitle>
          </CardHeader>
          <CardContent class="p-0">
            <ScrollArea class="max-h-[240px] bg-red-950/90 p-3 font-mono text-xs leading-relaxed text-red-100">
              <pre>{{ detail.stderr || t('common.empty') }}</pre>
            </ScrollArea>
          </CardContent>
        </Card>
      </template>
      <template v-else>
        <div class="grid h-full place-items-center text-sm text-muted-foreground">
          {{ t('history.selectToSeeDetails') }}
        </div>
      </template>
    </section>
  </div>
</template>