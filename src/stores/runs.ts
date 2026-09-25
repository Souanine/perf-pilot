import { defineStore } from "pinia";
import { computed, ref } from "vue";
import {
  api,
  type RunEvent,
  type RunOptions,
  type RunOutput,
  type RunRecord,
} from "@/lib/tauri";
import { stream } from "@/lib/k6-event-stream";

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

/**
 * Hard cap on how many stdout/stderr lines we keep in the live buffer.
 *
 * k6 emits a progress line roughly every 1–2s; a 30-minute soak pushes
 * 15k+ lines through the buffer. Capping here protects the renderer
 * (each line is one DOM node in the live pane) and the IPC payload when
 * the run is finished and the buffer is serialised back to the front end.
 * The full output is still persisted to disk by Rust, so a finished run
 * never loses detail — only the live tail viewer truncates.
 */
const MAX_LIVE_OUTPUT_LINES = 2000;

/** k6 allows concurrent runs, so two `runs.start()` calls inside the same
 *  millisecond would otherwise risk an ID collision with the old
 *  `Date.now() + Math.random()` scheme. crypto.randomUUID is available
 *  in every WebView Tauri 2 ships and gives 122 bits of entropy. */
function genId() {
  return "r-" + crypto.randomUUID();
}

/** Push onto an array but evict the oldest entries past the cap. */
function pushCapped(arr: string[], line: string, cap: number) {
  arr.push(line);
  if (arr.length > cap) {
    arr.splice(0, arr.length - cap);
  }
}

/** Apply a single event to its live run row. Extracted so `start()` can
 *  replay buffered events with the exact same logic the live handler uses. */
function applyEventToLive(run: LiveRun, ev: RunEvent) {
  switch (ev.kind) {
    case "started":
      run.started_at = ev.started_at;
      run.command = ev.command;
      run.k6_version = ev.k6_version;
      break;
    case "stdout":
      pushCapped(run.stdout_lines, ev.line, MAX_LIVE_OUTPUT_LINES);
      break;
    case "stderr":
      pushCapped(run.stderr_lines, ev.line, MAX_LIVE_OUTPUT_LINES);
      break;
    case "metric":
      run.metrics[ev.metric.name] = ev.metric.value;
      break;
    case "finished":
      run.finished_at = ev.finished_at;
      run.exit_code = ev.exit_code;
      run.status = ev.status;
      run.error = ev.error;
      break;
  }
}

export const useRunsStore = defineStore("runs", () => {
  const history = ref<RunRecord[]>([]);
  const live = ref<Record<string, LiveRun>>({});
  const selectedHistoryId = ref<string | null>(null);
  const detailCache = ref<Record<string, RunOutput>>({});

  // Register the store's routing function with the global stream. Re-runs of
  // the Pinia setup function (e.g. in tests that reset Pinia) just overwrite
  // the previous handler, which is what we want — only one router per app.
  stream.onEvent((ev) => {
    const run = live.value[ev.run_id];
    if (!run) return;
    applyEventToLive(run, ev);
    if (ev.kind === "finished") {
      refreshHistory().catch(() => {});
    }
  });

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

  async function start(scriptPath: string, options: RunOptions): Promise<string> {
    const id = genId();
    const fresh: LiveRun = {
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
    live.value[id] = fresh;

    // Drain any events Rust already emitted for this runId (e.g. a synchronous
    // `Started` that landed before we created the row). The stream buffers
    // those; replaying synchronously here closes the race.
    for (const ev of stream.takeBuffered(id)) {
      applyEventToLive(fresh, ev);
    }

    try {
      await api.runK6(id, scriptPath, options);
      return id;
    } catch (e) {
      // Roll back the optimistic entry so the UI doesn't show a phantom run.
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
  };
});