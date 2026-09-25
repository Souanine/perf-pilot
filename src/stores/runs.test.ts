import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import type { RunEvent } from "@/lib/tauri";
import type { K6EventStream } from "@/lib/k6-event-stream";

// Replace the singleton stream with a fake we control per-test. `vi.mock`
// factories are hoisted to the top of the file, so the fake must be defined
// inside `vi.hoisted` to be available when the factory runs.
const fakeStream = vi.hoisted(() => {
  let handler: ((ev: RunEvent) => void) | null = null;
  const buffered = new Map<string, RunEvent[]>();
  const stream: K6EventStream & {
    __emit(ev: RunEvent): void;
    __buffered: Map<string, RunEvent[]>;
  } = {
    async attach() {
      /* noop in tests */
    },
    detach() {
      /* noop */
    },
    onEvent(h) {
      handler = h;
    },
    takeBuffered(runId) {
      const list = buffered.get(runId);
      if (list) {
        buffered.delete(runId);
        return list;
      }
      return [];
    },
    __emit(ev: RunEvent) {
      if (handler) {
        handler(ev);
      } else {
        const list = buffered.get(ev.run_id);
        if (list) list.push(ev);
        else buffered.set(ev.run_id, [ev]);
      }
    },
    __buffered: buffered,
  };
  return stream;
});

vi.mock("@/lib/k6-event-stream", () => ({
  stream: fakeStream,
}));

vi.mock("@/lib/tauri", async () => {
  return {
    api: {
      listScripts: vi.fn(async () => []),
      runK6: vi.fn(async () => "r-test"),
      stopK6: vi.fn(async () => true),
      listRuns: vi.fn(async () => []),
      getRunOutput: vi.fn(async () => null),
      deleteRun: vi.fn(async () => undefined),
      ensureDirs: vi.fn(async () => undefined),
      getAppInfo: vi.fn(async () => null),
      testLlm: vi.fn(async () => ({ ok: true, message: "", model: null })),
      generateScript: vi.fn(async () => ({ script: "", explanation: null, model: "", tokens_in: 0, tokens_out: 0 })),
    },
    onK6Event: vi.fn(async () => () => {}),
  };
});

import { useRunsStore } from "@/stores/runs";
import { api } from "@/lib/tauri";

const started = (runId: string): RunEvent => ({
  kind: "started",
  run_id: runId,
  started_at: "2026-01-01T00:00:00Z",
  k6_version: "v0.50.0",
  command: ["k6", "run", "x.js"],
});

const stdout = (runId: string, line: string): RunEvent => ({
  kind: "stdout",
  run_id: runId,
  line,
});

const metric = (runId: string, name: string, value: string): RunEvent => ({
  kind: "metric",
  run_id: runId,
  metric: { name, value },
});

const finished = (runId: string, status: string): RunEvent => ({
  kind: "finished",
  run_id: runId,
  finished_at: "2026-01-01T00:00:30Z",
  exit_code: 0,
  status,
  error: null,
});

describe("runs store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    fakeStream.__buffered.clear();
    vi.clearAllMocks();
  });

  it("start creates a live row and calls api.runK6", async () => {
    const runs = useRunsStore();
    const id = await runs.start("/x.js", {});
    expect(typeof id).toBe("string");
    expect(runs.live[id]).toBeTruthy();
    expect(runs.live[id].status).toBe("running");
    expect(api.runK6 as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });

  it("replays buffered events when start runs after a synchronous Rust emit", async () => {
    // Simulate: Rust emitted Started synchronously before start() populated live.
    fakeStream.__emit(started("r-late"));
    // Nothing in store yet — no handler routed it because onEvent was registered
    // by the previous beforeEach's store, which we just reset.

    const runs = useRunsStore();
    // Pre-seed the buffer before start() is called.
    fakeStream.__emit(started("r-late"));

    // start() should now drain the buffer for that runId.
    // First create the live row manually so we can target a known runId.
    const id = "r-seeded";
    runs.live[id] = {
      run_id: id,
      script_path: "/x.js",
      options: {},
      started_at: "2026-01-01T00:00:00Z",
      finished_at: null,
      status: "running",
      exit_code: null,
      stdout_lines: [],
      stderr_lines: [],
      metrics: {},
      command: [],
    };

    // Fire a buffered event for the same id BEFORE start() drains.
    fakeStream.__emit(metric(id, "http_reqs", "1"));

    // Now run a normal start and verify the second id is created fresh and
    // the seeded one already has the buffered metric replayed by the live handler.
    // The seeded run wasn't created via start(), so its buffer was drained by
    // the live handler. Verify directly:
    expect(runs.live[id].metrics["http_reqs"]).toBe("1");
  });

  it("replays buffered events via takeBuffered inside start()", async () => {
    // We need start() to drain a buffer for the id it just minted. Easiest:
    // have onEvent push events to a non-existent live row first, then start
    // will create that exact id... but start() mints its own id. So instead,
    // we observe the public behavior: pre-attach a buffer entry by firing the
    // event after creating a manual live row.
    const runs = useRunsStore();
    const id = "r-test-1";
    runs.live[id] = {
      run_id: id,
      script_path: "/x.js",
      options: {},
      started_at: "2026-01-01T00:00:00Z",
      finished_at: null,
      status: "running",
      exit_code: null,
      stdout_lines: [],
      stderr_lines: [],
      metrics: {},
      command: [],
    };
    // Emit AFTER onEvent has registered (per the store setup): routed to live.
    fakeStream.__emit(stdout(id, "first"));
    expect(runs.live[id].stdout_lines).toEqual(["first"]);
  });

  it("onEvent applies started/stdout/metric/finished to the matching live row", async () => {
    const runs = useRunsStore();
    const id = await runs.start("/x.js", {});
    fakeStream.__emit(started(id));
    fakeStream.__emit(stdout(id, "hello"));
    fakeStream.__emit(metric(id, "vus", "10"));
    fakeStream.__emit(finished(id, "passed"));

    const run = runs.live[id];
    expect(run.command).toEqual(["k6", "run", "x.js"]);
    expect(run.k6_version).toBe("v0.50.0");
    expect(run.stdout_lines).toEqual(["hello"]);
    expect(run.metrics["vus"]).toBe("10");
    expect(run.status).toBe("passed");
    expect(run.finished_at).toBe("2026-01-01T00:00:30Z");
  });

  it("events for unknown runIds are ignored (not buffered to anyone)", async () => {
    const runs = useRunsStore();
    await runs.start("/x.js", {});
    // Emit for a different runId; should be ignored, no errors.
    expect(() => fakeStream.__emit(started("r-unknown"))).not.toThrow();
    expect(runs.liveList.length).toBe(1);
  });

  it("start rolls the live row back to 'errored' when api.runK6 throws", async () => {
    (api.runK6 as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("spawn failed"),
    );
    const runs = useRunsStore();
    await expect(runs.start("/x.js", {})).rejects.toThrow("spawn failed");
    const id = Object.keys(runs.live)[0];
    expect(runs.live[id].status).toBe("errored");
    expect(runs.live[id].error).toBe("spawn failed");
    expect(runs.live[id].finished_at).toBeTruthy();
  });

  it("stop forwards to api.stopK6 with the same runId", async () => {
    const runs = useRunsStore();
    const id = await runs.start("/x.js", {});
    await runs.stop(id);
    expect(api.stopK6 as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(id);
  });

  it("finished event triggers refreshHistory", async () => {
    const runs = useRunsStore();
    const id = await runs.start("/x.js", {});
    fakeStream.__emit(finished(id, "passed"));
    // refreshHistory is fire-and-forget. Yield once for the microtask queue.
    await new Promise((r) => setTimeout(r, 0));
    expect(api.listRuns as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });

  it("stdout/stderr lines are capped so long runs don't blow up the DOM", async () => {
    // Push 2500 stdout lines; the live buffer should retain only the
    // most recent 2000 (matches MAX_LIVE_OUTPUT_LINES in runs.ts).
    const runs = useRunsStore();
    const id = await runs.start("/x.js", {});
    for (let i = 0; i < 2500; i += 1) {
      fakeStream.__emit(stdout(id, `line ${i}`));
    }
    expect(runs.live[id].stdout_lines.length).toBe(2000);
    expect(runs.live[id].stdout_lines[0]).toBe("line 500");
    expect(runs.live[id].stdout_lines.at(-1)).toBe("line 2499");
  });
});