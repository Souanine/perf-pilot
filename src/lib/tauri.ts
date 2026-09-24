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

export interface LlmProviderConfig {
  provider: "openai" | "anthropic" | "ollama" | "custom";
  base_url: string;
  api_key: string;
  model: string;
  organization?: string | null;
  temperature: number;
}

export interface ScriptGenRequest {
  prompt: string;
  hint?: string;
  base_url?: string;
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
  testLlm: (provider: LlmProviderConfig) =>
    invoke<LlmTestResult>("test_llm", { provider }),
};

// Events
export function onK6Event(handler: (e: RunEvent) => void): Promise<UnlistenFn> {
  return listen<RunEvent>("k6://event", (event) => handler(event.payload));
}