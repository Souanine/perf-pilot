import { defineStore } from "pinia";
import { computed, ref } from "vue";
import {
  api,
  onK6Event,
  type RunEvent,
  type RunOptions,
  type RunOutput,
  type RunRecord,
} from "@/lib/tauri";

export interface LiveRun {
  run_id: string;
  script_path: string;
  options: RunOptions;
  started_at: string;
  finished_at: string | null;
  status: string;
  exit_code: number | null;
  stdout_lines: string[];
  stderr_lines: string[];
  metrics: Record<string, string>;
  command: string[];
  k6_version?: string;
  error?: string | null;
}

function genId() {
  return (
    "r-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 8)
  );
}

export const useRunsStore = defineStore("runs", () => {
  const history = ref<RunRecord[]>([]);
  const live = ref<Record<string, LiveRun>>({});
  const selectedHistoryId = ref<string | null>(null);
  const detailCache = ref<Record<string, RunOutput>>({});
  let unsub: (() => void) | null = null;

  async function refreshHistory() {
    history.value = await api.listRuns();
  }

  async function removeRun(runId: string): Promise<void> {
    if (detailCache.value[runId]) {
      const { [runId]: _, ...rest } = detailCache.value;
      detailCache.value = rest;
    }
    if (selectedHistoryId.value === runId) {
      selectedHistoryId.value = null;
    }
    await api.deleteRun(runId);
    await refreshHistory();
  }

  async function loadDetail(runId: string): Promise<RunOutput | null> {
    if (detailCache.value[runId]) return detailCache.value[runId];
    try {
      const out = await api.getRunOutput(runId);
      detailCache.value[runId] = out;
      return out;
    } catch {
      return null;
    }
  }

  async function attach() {
    if (unsub) return;
    unsub = await onK6Event((ev: RunEvent) => {
      const id = ev.run_id;
      if (!live.value[id]) return;
      switch (ev.kind) {
        case "started":
          live.value[id].started_at = ev.started_at;
          live.value[id].command = ev.command;
          live.value[id].k6_version = ev.k6_version;
          break;
        case "stdout":
          live.value[id].stdout_lines.push(ev.line);
          break;
        case "stderr":
          live.value[id].stderr_lines.push(ev.line);
          break;
        case "metric":
          live.value[id].metrics[ev.metric.name] = ev.metric.value;
          break;
        case "finished":
          live.value[id].finished_at = ev.finished_at;
          live.value[id].exit_code = ev.exit_code;
          live.value[id].status = ev.status;
          live.value[id].error = ev.error;
          // Refresh history asynchronously
          refreshHistory().catch(() => {});
          break;
      }
    });
  }

  function detach() {
    if (unsub) {
      unsub();
      unsub = null;
    }
  }

  async function start(scriptPath: string, options: RunOptions): Promise<string> {
    const id = genId();
    live.value[id] = {
      run_id: id,
      script_path: scriptPath,
      options,
      started_at: new Date().toISOString(),
      finished_at: null,
      status: "running",
      exit_code: null,
      stdout_lines: [],
      stderr_lines: [],
      metrics: {},
      command: [],
    };
    await attach();
    try {
      await api.runK6(id, scriptPath, options);
      return id;
    } catch (e) {
      // Roll back the optimistic entry so the UI doesn't show a phantom "running" run.
      const liveRun = live.value[id];
      if (liveRun) {
        liveRun.status = "errored";
        liveRun.finished_at = new Date().toISOString();
        liveRun.error = e instanceof Error ? e.message : String(e);
      }
      throw e;
    }
  }

  async function stop(runId: string) {
    await api.stopK6(runId);
  }

  const liveList = computed(() => Object.values(live.value));

  const running = computed(() => liveList.value.filter((r) => r.status === "running"));

  return {
    history,
    live,
    selectedHistoryId,
    detailCache,
    liveList,
    running,
    refreshHistory,
    loadDetail,
    removeRun,
    start,
    stop,
    attach,
    detach,
  };
});