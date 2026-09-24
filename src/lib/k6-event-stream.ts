/**
 * K6 event stream adapter.
 *
 * Owns the Tauri IPC subscription for k6 run events and bridges them to the
 * Runs store. Events that arrive before a store consumer is registered (or
 * before a live run row exists) are buffered by runId and can be replayed
 * synchronously via `takeBuffered`.
 *
 * The adapter is decoupled from the Tauri API: production wiring uses
 * `tauriSubscribe`, tests inject their own emitter via the `attach(subscribe)`
 * argument.
 */
import { onK6Event, type RunEvent } from "@/lib/tauri";
import type { UnlistenFn } from "@tauri-apps/api/event";

export type EventHandler = (event: RunEvent) => void;
export type Subscribe = (handler: EventHandler) => Promise<UnlistenFn>;

/** Production wiring: bridges tauri.ts's `onK6Event` (which already unwraps the
 *  payload) to our flat EventHandler signature. */
export const tauriSubscribe: Subscribe = (handler) => onK6Event(handler);

export interface K6EventStream {
  /** Subscribe once. Subsequent calls are idempotent until `detach()`. */
  attach(subscribe?: Subscribe): Promise<void>;
  /** Unsubscribe. The buffer is intentionally preserved so a future
   *  `attach()` can still drain any in-flight events. */
  detach(): void;
  /** Register (or replace) the route the stream feeds events into. */
  onEvent(handler: EventHandler): void;
  /** Pop and clear any events buffered for `runId`. Returns an empty array
   *  if none were buffered. */
  takeBuffered(runId: string): RunEvent[];
}

export function createK6EventStream(): K6EventStream {
  let handler: EventHandler | null = null;
  let unsub: UnlistenFn | null = null;
  let buffered: Map<string, RunEvent[]> = new Map();

  const bufferEvent = (ev: RunEvent) => {
    const list = buffered.get(ev.run_id);
    if (list) {
      list.push(ev);
    } else {
      buffered.set(ev.run_id, [ev]);
    }
  };

  return {
    async attach(subscribe: Subscribe = tauriSubscribe): Promise<void> {
      if (unsub) return;
      unsub = await subscribe((ev) => {
        if (handler) {
          handler(ev);
        } else {
          bufferEvent(ev);
        }
      });
    },

    detach(): void {
      if (unsub) {
        unsub();
        unsub = null;
      }
    },

    onEvent(h: EventHandler): void {
      handler = h;
    },

    takeBuffered(runId: string): RunEvent[] {
      const list = buffered.get(runId);
      if (list) {
        buffered.delete(runId);
        return list;
      }
      return [];
    },
  };
}

/** Module-level singleton; `App.vue` calls `attach()` once at startup. */
export const stream: K6EventStream = createK6EventStream();