import { describe, it, expect, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { nextTick } from "vue";
import LiveOutputPane from "@/components/LiveOutputPane.vue";

/**
 * LiveOutputPane's contract:
 * - Snaps to the bottom whenever new lines arrive (while at the bottom).
 * - Stops auto-following when the user scrolls up past a small threshold.
 * - Shows a "Jump to latest" pill when auto-follow is off; clicking it
 *   re-arms auto-follow and snaps back to the bottom.
 * - Resumes auto-follow silently if the user happens to be near the
 *   bottom again when new lines arrive.
 *
 * The component manipulates the real DOM scroller, so each test mounts
 * a fresh pane and stubs scrollHeight / clientHeight to simulate
 * different positions in the buffer.
 */

function mountPane(propsOverride: Partial<InstanceType<typeof LiveOutputPane>["$props"]> = {}) {
  const props = {
    lines: [] as string[],
    tone: "stdout" as const,
    placeholder: "",
    nearBottomPx: 32,
    ...propsOverride,
  };
  return mount(LiveOutputPane, { props, attachTo: document.body });
}

/** Simulate the scroller reporting a position. Returns the resulting
 *  `scrollTop` you can observe on the live element afterwards. */
function setScroll(wrapper: ReturnType<typeof mountPane>, args: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}) {
  const el = wrapper.find("pre").element as HTMLPreElement;
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: args.scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: args.clientHeight });
  el.scrollTop = args.scrollTop;
  return el;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("LiveOutputPane", () => {
  it("renders nothing when lines is empty and no placeholder is given", () => {
    const wrapper = mountPane({ lines: [] });
    expect(wrapper.find("pre").text()).toBe("");
  });

  it("renders the placeholder when lines is empty and a placeholder is given", () => {
    const wrapper = mountPane({ lines: [], placeholder: "waiting…" });
    expect(wrapper.find("pre").text()).toBe("waiting…");
  });

  it("renders one block per line", () => {
    const wrapper = mountPane({ lines: ["a", "b", "c"] });
    const blocks = wrapper.findAll("pre span.block");
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    // First three blocks are the lines; trailing blocks are filtered out.
    expect(blocks[0].text()).toBe("a");
    expect(blocks[1].text()).toBe("b");
    expect(blocks[2].text()).toBe("c");
  });

  it("snaps to the bottom when a new line arrives and the user is at the bottom", async () => {
    const wrapper = mountPane({ lines: ["line1", "line2"] });
    await flushPromises();
    const el = wrapper.find("pre").element as HTMLPreElement;
    // Pretend the pane is filled and the user is parked at the bottom.
    const scrolled = setScroll(wrapper, {
      scrollTop: 100,
      scrollHeight: 200,
      clientHeight: 100,
    });
    // Simulate a scroll event at the bottom so the component sees we're
    // at the bottom (auto-follow re-arms / stays on).
    el.dispatchEvent(new Event("scroll"));
    await nextTick();

    // Now push more lines; expect scrollTop to be re-set to scrollHeight.
    Object.defineProperty(scrolled, "scrollHeight", { configurable: true, value: 300 });
    Object.defineProperty(scrolled, "clientHeight", { configurable: true, value: 100 });
    await wrapper.setProps({ lines: ["line1", "line2", "line3"] });
    await flushPromises();

    expect(scrolled.scrollTop).toBe(300);
  });

  it("does not yank the user back when they have scrolled up", async () => {
    const wrapper = mountPane({ lines: ["line1", "line2"] });
    await flushPromises();
    const el = wrapper.find("pre").element as HTMLPreElement;
    // User is parked at the bottom with auto-follow armed.
    setScroll(wrapper, { scrollTop: 200, scrollHeight: 300, clientHeight: 100 });
    el.dispatchEvent(new Event("scroll"));
    await nextTick();

    // Now the user scrolls up to inspect line 1 — past the near-bottom
    // threshold. autoFollow should turn off.
    setScroll(wrapper, { scrollTop: 0, scrollHeight: 300, clientHeight: 100 });
    el.dispatchEvent(new Event("scroll"));
    await nextTick();
    expect(wrapper.find("button").exists()).toBe(true);

    // New line arrives; scrollTop should NOT be changed.
    setScroll(wrapper, { scrollTop: 0, scrollHeight: 400, clientHeight: 100 });
    await wrapper.setProps({ lines: ["line1", "line2", "line3"] });
    await flushPromises();

    const el2 = wrapper.find("pre").element as HTMLPreElement;
    expect(el2.scrollTop).toBe(0);
  });

  it("shows a 'Jump to latest' pill while auto-follow is off", async () => {
    const wrapper = mountPane({ lines: ["line1", "line2"] });
    await flushPromises();
    const el = wrapper.find("pre").element as HTMLPreElement;
    setScroll(wrapper, { scrollTop: 200, scrollHeight: 300, clientHeight: 100 });
    el.dispatchEvent(new Event("scroll"));
    await nextTick();

    setScroll(wrapper, { scrollTop: 0, scrollHeight: 300, clientHeight: 100 });
    el.dispatchEvent(new Event("scroll"));
    await nextTick();

    const btn = wrapper.find("button");
    expect(btn.exists()).toBe(true);
    expect(btn.text()).toContain("Jump to latest");
  });

  it("clicking the 'Jump to latest' pill re-arms auto-follow and scrolls to the bottom", async () => {
    const wrapper = mountPane({ lines: ["line1", "line2"] });
    await flushPromises();
    const el = wrapper.find("pre").element as HTMLPreElement;
    setScroll(wrapper, { scrollTop: 200, scrollHeight: 300, clientHeight: 100 });
    el.dispatchEvent(new Event("scroll"));
    await nextTick();
    setScroll(wrapper, { scrollTop: 0, scrollHeight: 300, clientHeight: 100 });
    el.dispatchEvent(new Event("scroll"));
    await nextTick();

    const btn = wrapper.find("button");
    expect(btn.exists()).toBe(true);

    // Stub scrollTo so the test can observe the call without relying on
    // jsdom's incomplete scrollTo implementation.
    const elAfterScroll = wrapper.find("pre").element as HTMLPreElement;
    const scrollTo = vi.fn();
    elAfterScroll.scrollTo = scrollTo as unknown as typeof elAfterScroll.scrollTo;

    await btn.trigger("click");
    await flushPromises();

    expect(scrollTo).toHaveBeenCalled();
    // After clicking, the button should be gone (auto-follow is on again).
    expect(wrapper.find("button").exists()).toBe(false);
  });

  it("re-arms auto-follow when the user is near the bottom and a new line arrives", async () => {
    const wrapper = mountPane({ lines: ["line1", "line2"] });
    await flushPromises();
    const el = wrapper.find("pre").element as HTMLPreElement;
    setScroll(wrapper, { scrollTop: 200, scrollHeight: 300, clientHeight: 100 });
    el.dispatchEvent(new Event("scroll"));
    await nextTick();
    setScroll(wrapper, { scrollTop: 0, scrollHeight: 300, clientHeight: 100 });
    el.dispatchEvent(new Event("scroll"));
    await nextTick();
    expect(wrapper.find("button").exists()).toBe(true);

    // User scrolls back down close to the bottom (within 32px).
    setScroll(wrapper, { scrollTop: 268, scrollHeight: 300, clientHeight: 100 });
    el.dispatchEvent(new Event("scroll"));
    await nextTick();
    expect(wrapper.find("button").exists()).toBe(false);
  });

  it("applies tone-specific color classes", () => {
    const stdout = mountPane({ tone: "stdout" });
    expect(stdout.find("pre").classes().join(" ")).toContain("bg-black/95");
    expect(stdout.find("pre").classes().join(" ")).toContain("text-emerald-100");

    const stderr = mountPane({ tone: "stderr" });
    expect(stderr.find("pre").classes().join(" ")).toContain("bg-red-950/90");
    expect(stderr.find("pre").classes().join(" ")).toContain("text-red-100");

    const plain = mountPane({ tone: "plain" });
    expect(plain.find("pre").classes().join(" ")).toContain("bg-muted/60");
  });

  it("ignores content-driven height changes that come with scrollTop==0", async () => {
    // When content shrinks while we're parked at the top (scrollTop=0)
    // we should NOT silently re-arm auto-follow — the user is still
    // looking at older lines.
    const wrapper = mountPane({ lines: ["line1", "line2", "line3"] });
    await flushPromises();
    const el = wrapper.find("pre").element as HTMLPreElement;
    setScroll(wrapper, { scrollTop: 100, scrollHeight: 300, clientHeight: 100 });
    el.dispatchEvent(new Event("scroll"));
    await nextTick();
    setScroll(wrapper, { scrollTop: 0, scrollHeight: 300, clientHeight: 100 });
    el.dispatchEvent(new Event("scroll"));
    await nextTick();
    expect(wrapper.find("button").exists()).toBe(true);

    // Content shrinks (e.g. a run list rerender). scrollHeight drops
    // but scrollTop stays at 0. We should NOT clear the jump button.
    setScroll(wrapper, { scrollTop: 0, scrollHeight: 200, clientHeight: 100 });
    el.dispatchEvent(new Event("scroll"));
    await nextTick();
    expect(wrapper.find("button").exists()).toBe(true);
  });
});

// Minimal vi.fn shim — vitest provides this globally but we want the
// component file to compile in isolation too. Vitest picks it up at
// test-run time via globals: true in vitest.config.
declare const vi: { fn(): (...args: unknown[]) => unknown };