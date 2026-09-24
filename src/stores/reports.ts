import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api, type ReportRecord, type ReportGenResponse } from "@/lib/tauri";
import { useLLMStore } from "@/stores/llm";
import { useLocaleStore } from "@/stores/locale";

export interface ReportEntry extends ReportRecord {
  /** Cached markdown body — fetched lazily by `load()` to avoid loading
   *  every report's body during the initial list refresh. */
  body: string | null;
  loading: boolean;
}

/**
 * Pinia store for generated run reports.
 *
 * The store keeps an index of reports by `run_id` (mirroring what's on
 * disk) plus the markdown body of whichever report is currently open.
 * Generation goes through `generate(runId)` and reuses the active LLM
 * provider from `useLLMStore`.
 */
export const useReportsStore = defineStore("reports", () => {
  const index = ref<Record<string, ReportEntry>>({});
  const openRunId = ref<string | null>(null);
  const openBody = ref<string | null>(null);
  const generating = ref<Record<string, boolean>>({});
  const lastError = ref<Record<string, string>>({});

  function entries(): ReportEntry[] {
    return Object.values(index.value);
  }

  function forRun(runId: string): ReportEntry | null {
    return index.value[runId] ?? null;
  }

  function isGenerating(runId: string): boolean {
    return !!generating.value[runId];
  }

  function errorFor(runId: string): string | null {
    return lastError.value[runId] ?? null;
  }

  const hasReport = computed(() => Object.keys(index.value).length > 0);

  /** Re-read the on-disk index. Cheap; safe to call on app startup. */
  async function refresh() {
    try {
      const list = await api.listReports();
      const next: Record<string, ReportEntry> = {};
      for (const r of list) {
        next[r.run_id] = { ...r, body: index.value[r.run_id]?.body ?? null, loading: false };
      }
      index.value = next;
      // Drop the cached body if its run was deleted on disk.
      if (openRunId.value && !next[openRunId.value]) {
        openRunId.value = null;
        openBody.value = null;
      }
    } catch {
      // Ignore — empty store is fine if the backend has no reports yet.
    }
  }

  /** Fetch the markdown body for a run if it isn't already cached. */
  async function load(runId: string): Promise<string | null> {
    const existing = index.value[runId];
    if (existing?.body) {
      openRunId.value = runId;
      openBody.value = existing.body;
      return existing.body;
    }
    try {
      const body = await api.readReport(runId);
      if (index.value[runId]) {
        index.value[runId].body = body;
      } else {
        // The file exists on disk but isn't in the cached index yet — add
        // a minimal entry so subsequent refreshes don't blow it away.
        index.value[runId] = {
          run_id: runId,
          path: "",
          model: null,
          created_at: new Date().toISOString(),
          size: body.length,
          body,
          loading: false,
        };
      }
      openRunId.value = runId;
      openBody.value = body;
      return body;
    } catch (e: unknown) {
      lastError.value[runId] = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  /** Generate (or regenerate) the report for a run using the active LLM. */
  async function generate(runId: string): Promise<ReportGenResponse | null> {
    const llm = useLLMStore();
    const locale = useLocaleStore();
    if (!llm.active?.model) {
      lastError.value[runId] = "No active LLM model — configure one in LLM Settings.";
      return null;
    }
    generating.value[runId] = true;
    lastError.value[runId] = "";
    try {
      const resp = await api.generateReport(llm.active, {
        run_id: runId,
        locale: locale.locale,
      });
      // Patch / insert the index entry.
      const now = new Date().toISOString();
      index.value[runId] = {
        run_id: runId,
        path: "",
        model: resp.model,
        created_at: now,
        size: resp.report.length,
        body: resp.report,
        loading: false,
      };
      openRunId.value = runId;
      openBody.value = resp.report;
      return resp;
    } catch (e: unknown) {
      lastError.value[runId] = e instanceof Error ? e.message : String(e);
      return null;
    } finally {
      generating.value[runId] = false;
    }
  }

  /** Drop the cached report and the on-disk file. */
  async function discard(runId: string) {
    try {
      await api.deleteReport(runId);
    } catch {
      // Disk delete is best-effort; the in-memory cache must still drop.
    }
    delete index.value[runId];
    if (openRunId.value === runId) {
      openRunId.value = null;
      openBody.value = null;
    }
  }

  function close() {
    openRunId.value = null;
    openBody.value = null;
  }

  return {
    index,
    openRunId,
    openBody,
    entries,
    forRun,
    isGenerating,
    errorFor,
    hasReport,
    refresh,
    load,
    generate,
    discard,
    close,
  };
});