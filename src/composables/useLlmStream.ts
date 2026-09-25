/**
 * Single-connection LLM stream router.
 *
 * Subscribes to the `llm://chunk` Tauri event once and demultiplexes events
 * to whichever caller owns the matching `requestId`. Callers obtain a
 * controller with {@link start} and feed the request id into one of the
 * `*_stream` Tauri commands; the returned promise resolves on the matching
 * `done` event and rejects on `error`.
 *
 * Why a singleton: every page would otherwise need its own `listen()` call,
 * paying the IPC setup cost repeatedly and racing on unsubscribes.
 */
import { onUnmounted } from "vue";
import { onLlmStream, type LlmStreamEvent } from "@/lib/tauri";
import type { UnlistenFn } from "@tauri-apps/api/event";

interface PendingRequest {
  onDelta: (chunk: string) => void;
  resolve: (event: Extract<LlmStreamEvent, { phase: "done" }>) => void;
  reject: (err: Error) => void;
  /** Best-effort model id; updated on `started`. */
  model: string;
}

const pending = new Map<string, PendingRequest>();
let unsubscribe: UnlistenFn | null = null;
let subscribed = false;

/** Lazily subscribe once; idempotent. */
async function ensureSubscribed() {
  if (subscribed) return;
  subscribed = true;
  try {
    unsubscribe = await onLlmStream((ev) => route(ev));
  } catch {
    // Non-Tauri environments (tests, browser dev) fall back to a no-op.
    subscribed = false;
  }
}

function route(ev: LlmStreamEvent) {
  const entry = pending.get(ev.request_id);
  if (!entry) return;
  switch (ev.phase) {
    case "started":
      entry.model = ev.model;
      return;
    case "delta":
      entry.onDelta(ev.text);
      return;
    case "done":
      pending.delete(ev.request_id);
      entry.resolve(ev);
      return;
    case "error":
      pending.delete(ev.request_id);
      entry.reject(new Error(ev.message));
      return;
  }
}

export interface StreamController {
  /** Live model id (filled in on `started`). */
  readonly model: string;
  /** Promise that resolves on `done`, rejects on `error`. */
  result: Promise<Extract<LlmStreamEvent, { phase: "done" }>>;
  /** Cancel the request: drops the pending entry so future events are
   *  ignored. The backend stream itself is fire-and-forget until done. */
  cancel(): void;
}

/**
 * Register a slot for a streaming request. Call after you've fired the
 * matching `*_stream` Tauri command so events that arrive before this
 * call aren't lost — they'll still be buffered on the Rust side and
 * forwarded, but a slow start will miss early deltas if no slot exists.
 */
export async function startLlmStream(
  requestId: string,
  onDelta: (chunk: string) => void,
): Promise<StreamController> {
  await ensureSubscribed();
  let entry!: PendingRequest;
  const result = new Promise<Extract<LlmStreamEvent, { phase: "done" }>>(
    (resolve, reject) => {
      entry = {
        onDelta,
        resolve,
        reject,
        model: "",
      };
      pending.set(requestId, entry);
    },
  );
  return {
    get model() {
      return entry.model;
    },
    result,
    cancel() {
      pending.delete(requestId);
    },
  };
}

/** Module-level counter — caller passes this to the backend. */
let counter = 0;
export function newStreamRequestId(): string {
  counter += 1;
  // Stable across reloads within the same process; nonces mean two
  // concurrent requests can't collide.
  return `s-${Date.now().toString(36)}-${counter}`;
}

/** Reset everything — primarily a test hook. */
export function _resetLlmStream() {
  pending.clear();
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  subscribed = false;
}

/** Composables that hold a stream can hook into the Vue lifecycle to
 *  auto-cancel on unmount. Returns the controller's `cancel` so the
 *  caller can fire it from elsewhere too. */
export function useAutoCancel(controller: StreamController): void {
  onUnmounted(() => controller.cancel());
}
