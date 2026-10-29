/**
 * Centralized wrapper around Tauri IPC commands defined in src-tauri/src/lib.rs.
 * Every command from Rust is mirrored here.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface K6Info {
  version: string;
  path: string;
}

export interface AppInfo {
  app_version: string;
  k6_info: K6Info | null;
  app_data_dir: string;
  scripts_dir: string;
  runs_dir: string;
}

export interface ScriptFile {
  path: string;
  name: string;
  size: number;
  modified_at: string;
}

export interface RunRecord {
  run_id: string;
  label: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  script_path: string;
  /** `http_req_duration` p(95) in milliseconds, extracted at conclude
   *  time. Drives the Dashboard trend chart; undefined for older runs
   *  that predate the index field. */
  p95_ms?: number | null;
  /** Throughput in requests per second, from `http_reqs`. */
  rps?: number | null;
  /** Error rate as a percentage (0–100), from `http_req_failed`. */
  error_rate_pct?: number | null;
}

export interface MetricSummary {
  name: string;
  value: string;
  unit?: string | null;
}

export interface RunOutput {
  run_id: string;
  script_path: string;
  label: string | null;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  status: string;
  stdout: string;
  stderr: string;
  metrics: MetricSummary[];
  error: string | null;
}

export interface RunOptions {
  label?: string;
  env?: Record<string, string>;
  cli_args?: string[];
  max_duration_seconds?: number;
  /** Credential ids whose secret values Rust injects into the k6 process
   *  env at spawn time. Ids only — values never cross the IPC bridge. */
  credentials?: string[];
}

export type RunEvent =
  | {
      kind: "started";
      run_id: string;
      started_at: string;
      k6_version: string;
      command: string[];
    }
  | { kind: "stdout"; run_id: string; line: string }
  | { kind: "stderr"; run_id: string; line: string }
  | { kind: "metric"; run_id: string; metric: MetricSummary }
  | {
      kind: "finished";
      run_id: string;
      finished_at: string;
      exit_code: number | null;
      status: string;
      error: string | null;
    };

export type ApiFormat = "chat_completions" | "anthropic_messages" | "responses";

export interface LlmModelSpec {
  id: string;
  /** Optional human-readable label shown in selectors; falls back to `id`. */
  label?: string | null;
}

export interface LlmProviderConfig {
  /** Stable opaque id for this provider (UUID v4 generated client-side). */
  id: string;
  /** Display name in the settings UI. Free-form, not required to be unique. */
  name: string;
  /** Wire format / API family this provider speaks. */
  api_format: ApiFormat;
  base_url: string;
  api_key: string;
  /** Currently selected model id; must match one of `models[*].id`. */
  model: string;
  organization?: string | null;
  temperature: number;
  /** Catalog of model ids the user can switch between for this provider. */
  models: LlmModelSpec[];
}

export type CredentialMode =
  | "token"
  | "basic"
  | "apikey"
  | "oauth2_client"
  | "oauth2_refresh";

/** Metadata-only view of a credential sent to the LLM with each script
 *  generation request — env var names and pool sizes, never values. */
export interface CredentialBrief {
  name: string;
  mode: CredentialMode;
  envKey: string;
  userEnvKey?: string | null;
  passEnvKey?: string | null;
  headerName?: string | null;
  location?: string | null;
  tokenUrl?: string | null;
  scope?: string | null;
  valueCount: number;
}

export interface ScriptGenRequest {
  prompt: string;
  hint?: string;
  base_url?: string;
  /** Configured credentials (metadata only) so generated scripts read the
   *  exact `__ENV` names the runtime will inject. */
  credentials?: CredentialBrief[];
}

export interface ScriptGenResponse {
  script: string;
  explanation: string | null;
  model: string;
  tokens_in: number | null;
  tokens_out: number | null;
}

export interface LlmTestResult {
  ok: boolean;
  message: string;
  model: string | null;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ReportGenRequest {
  run_id: string;
  locale?: string;
}

export interface ReportGenResponse {
  report: string;
  model: string;
  tokens_in: number | null;
  tokens_out: number | null;
}

export interface ReportRecord {
  run_id: string;
  path: string;
  model: string | null;
  created_at: string;
  size: number;
}

// Commands
export const api = {
  getAppInfo: () => invoke<AppInfo>("get_app_info"),
  ensureDirs: () => invoke<void>("ensure_dirs"),
  listScripts: () => invoke<ScriptFile[]>("list_scripts"),
  readScript: (path: string) => invoke<string>("read_script", { path }),
  writeScript: (path: string, content: string) =>
    invoke<void>("write_script", { path, content }),
  deleteScript: (path: string) => invoke<void>("delete_script", { path }),
  runK6: (
    runId: string,
    scriptPath: string,
    options: RunOptions,
  ) => invoke<string>("run_k6", { runId, scriptPath, options }),
  stopK6: (runId: string) => invoke<boolean>("stop_k6", { runId }),
  listRuns: () => invoke<RunRecord[]>("list_runs"),
  getRunOutput: (runId: string) => invoke<RunOutput>("get_run_output", { runId }),
  deleteRun: (runId: string) => invoke<void>("delete_run", { runId }),
  generateScript: (
    provider: LlmProviderConfig,
    request: ScriptGenRequest,
    history?: ChatMessage[],
  ) =>
    invoke<ScriptGenResponse>("generate_script", {
      provider,
      request,
      history: history ?? null,
    }),
  /**
   * Streaming variant of `generateScript`. The caller must already be
   * subscribed to `onLlmStream` with the same `requestId`. The promise
   * resolves with the same shape as `generateScript` after the `done`
   * event lands; it rejects with the streamed `error.message` if the
   * backend emits an error frame before completion.
   */
  generateScriptStream: (
    requestId: string,
    provider: LlmProviderConfig,
    request: ScriptGenRequest,
    history?: ChatMessage[],
  ) =>
    invoke<ScriptGenResponse>("generate_script_stream", {
      requestId,
      provider,
      request,
      history: history ?? null,
    }),
  testLlm: (provider: LlmProviderConfig) =>
    invoke<LlmTestResult>("test_llm", { provider }),
  generateReport: (
    provider: LlmProviderConfig,
    request: ReportGenRequest,
  ) =>
    invoke<ReportGenResponse>("generate_report", {
      provider,
      request,
    }),
  generateReportStream: (
    requestId: string,
    provider: LlmProviderConfig,
    request: ReportGenRequest,
  ) =>
    invoke<ReportGenResponse>("generate_report_stream", {
      requestId,
      provider,
      request,
    }),
  listReports: () => invoke<ReportRecord[]>("list_reports"),
  readReport: (runId: string) => invoke<string>("read_report", { runId }),
  deleteReport: (runId: string) => invoke<void>("delete_report", { runId }),

  // --- Secret store -------------------------------------------------------
  // Provider API keys live in the OS credential store (macOS Keychain /
  // Windows Credential Manager / Linux Secret Service), never in
  // perf-pilot.settings.json. See src-tauri/src/secrets.rs.

  /** Read a provider's stored key, or `null` when none is stored. */
  secretGet: (providerId: string) =>
    invoke<string | null>("secret_get", { providerId }),
  /** Store (or overwrite) a provider's key. */
  secretSet: (providerId: string, value: string) =>
    invoke<void>("secret_set", { providerId, value }),
  /** Remove a provider's key. Succeeds when no key was stored. */
  secretDelete: (providerId: string) =>
    invoke<void>("secret_delete", { providerId }),

  // --- Credential vault ---------------------------------------------------
  // Load-test auth values (tokens, passwords, OAuth client secrets) live in
  // the OS credential store under `cred:<id>:<index>` — one entry per pool
  // value. There is deliberately no get command: values are write-only from
  // the frontend and only read back inside Rust at k6 spawn time. See
  // src-tauri/src/credentials.rs.

  /** Overwrite the whole secret pool for a credential. */
  credentialSetValues: (id: string, values: string[]) =>
    invoke<void>("credential_set_values", { id, values }),
  /** Remove every keychain entry of a credential. No-op when absent. */
  credentialDelete: (id: string) => invoke<void>("credential_delete", { id }),
};

// Events
export function onK6Event(handler: (e: RunEvent) => void): Promise<UnlistenFn> {
  return listen<RunEvent>("k6://event", (event) => handler(event.payload));
}

// --- LLM streaming ----------------------------------------------------
// `LlmStreamEvent` is the discriminated union emitted on the
// `llm://chunk` channel. Each event is tagged with a `request_id` so the
// frontend can interleave concurrent streams without confusion.

export type LlmStreamEvent =
  | { phase: "started"; request_id: string; model: string }
  | { phase: "delta"; request_id: string; text: string }
  | {
      phase: "done";
      request_id: string;
      text: string;
      model: string;
      tokens_in: number | null;
      tokens_out: number | null;
    }
  | { phase: "error"; request_id: string; message: string };

export function onLlmStream(
  handler: (e: LlmStreamEvent) => void,
): Promise<UnlistenFn> {
  return listen<LlmStreamEvent>("llm://chunk", (event) =>
    handler(event.payload),
  );
}