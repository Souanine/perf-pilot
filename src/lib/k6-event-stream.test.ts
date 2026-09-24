import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createK6EventStream,
  type EventHandler,
  type Subscribe,
  type K6EventStream,
} from "@/lib/k6-event-stream";
import type { RunEvent } from "@/lib/tauri";

/** Build a fake emitter that records the handler the stream subscribes with
 *  and lets the test fire events on demand. */
function fakeEmitter() {
  let registered: EventHandler | null = null;
  let subscribed = false;
  let unsubscribed = false;
  const subscribe: Subscribe = vi.fn(async (h) => {
    registered = h;
    subscribed = true;
    return () => {
      unsubscribed = true;
      registered = null;
    };
  });
  return {
    subscribe,
    fire(ev: RunEvent) {
      if (!registered) throw new Error("no handler registered");
      registered(ev);
    },
    get isSubscribed() {
      return subscribed;
    },
    get isUnsubscribed() {
      return unsubscribed;
    },
    get hasHandler() {
      return registered !== null;
    },
  };
}

const ev = (kind: RunEvent["kind"], runId: string, extras: Partial<RunEvent> = {}): RunEvent => {
  const base = { run_id: runId } as const;
  switch (kind) {
    case "started":
      return {
        kind,
        run_id: runId,
        started_at: "2026-01-01T00:00:00Z",
        k6_version: "v0.50.0",
        command: ["k6", "run"],
        ...extras,
      } as RunEvent;
    case "stdout":
      return { kind, run_id: runId, line: "stdout line", ...extras } as RunEvent;
    case "stderr":
      return { kind, run_id: runId, line: "stderr line", ...extras } as RunEvent;
    case "metric":
      return { kind, run_id: runId, metric: { name: "http_reqs", value: "1" }, ...extras } as RunEvent;
    case "finished":
      return {
        kind,
        run_id: runId,
        finished_at: "2026-01-01T00:00:01Z",
        exit_code: 0,
        status: "passed",
        error: null,
        ...extras,
      } as RunEvent;
  }
};

describe("k6-event-stream", () => {
  let s: K6EventStream;
  let em: ReturnType<typeof fakeEmitter>;

  beforeEach(() => {
    s = createK6EventStream();
    em = fakeEmitter();
  });

  it("attach is idempotent until detach", async () => {
    await s.attach(em.subscribe);
    await s.attach(em.subscribe);
    expect(em.subscribe).toHaveBeenCalledTimes(1);
  });

  it("detach unsubscribes and allows reattach", async () => {
    await s.attach(em.subscribe);
    s.detach();
    expect(em.isUnsubscribed).toBe(true);

    const em2 = fakeEmitter();
    await s.attach(em2.subscribe);
    expect(em2.isSubscribed).toBe(true);
  });

  it("handler registered before attach still receives events", async () => {
    const received: RunEvent[] = [];
    s.onEvent((e) => received.push(e));
    await s.attach(em.subscribe);
    em.fire(ev("started", "r1"));
    em.fire(ev("stdout", "r1"));
    expect(received.map((e) => e.kind)).toEqual(["started", "stdout"]);
    // Buffer should be empty: every event went through the handler.
    expect(s.takeBuffered("r1")).toEqual([]);
  });

  it("buffers events when no handler is registered yet", async () => {
    await s.attach(em.subscribe);
    em.fire(ev("started", "r1"));
    em.fire(ev("stdout", "r1"));
    expect(s.takeBuffered("r1").map((e) => e.kind)).toEqual(["started", "stdout"]);
    // Drained.
    expect(s.takeBuffered("r1")).toEqual([]);
  });

  it("takeBuffered returns and clears the buffer for that runId only", async () => {
    await s.attach(em.subscribe);
    em.fire(ev("started", "r1"));
    em.fire(ev("started", "r2"));
    em.fire(ev("stdout", "r2"));

    const r1 = s.takeBuffered("r1");
    expect(r1.map((e) => e.kind)).toEqual(["started"]);

    // r1 buffer cleared; r2 still has both events.
    expect(s.takeBuffered("r1")).toEqual([]);
    const r2 = s.takeBuffered("r2");
    expect(r2.map((e) => e.kind)).toEqual(["started", "stdout"]);
  });

  it("handler registered later sees only events fired after registration", async () => {
    await s.attach(em.subscribe);
    em.fire(ev("started", "r1"));

    const received: RunEvent[] = [];
    s.onEvent((e) => received.push(e));
    em.fire(ev("stdout", "r1"));

    expect(received.map((e) => e.kind)).toEqual(["stdout"]);
    // The early `started` is still in the buffer awaiting a takeBuffered call.
    expect(s.takeBuffered("r1").map((e) => e.kind)).toEqual(["started"]);
  });

  it("detach preserves the buffer; a later takeBuffered still returns events", async () => {
    await s.attach(em.subscribe);
    em.fire(ev("started", "r1"));
    s.detach();

    expect(s.takeBuffered("r1").map((e) => e.kind)).toEqual(["started"]);
  });

  it("onEvent replaces the previous handler", async () => {
    await s.attach(em.subscribe);
    const a: RunEvent[] = [];
    const b: RunEvent[] = [];
    s.onEvent((e) => a.push(e));
    s.onEvent((e) => b.push(e));

    em.fire(ev("stdout", "r1"));
    expect(a).toEqual([]);
    expect(b.map((e) => e.kind)).toEqual(["stdout"]);
  });

  it("takeBuffered on an unknown runId returns an empty array", () => {
    expect(s.takeBuffered("never-seen")).toEqual([]);
  });
});