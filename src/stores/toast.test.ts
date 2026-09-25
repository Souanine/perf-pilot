import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useToastStore } from "@/stores/toast";

describe("toast store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
  });

  it("push adds an item and assigns a unique id", () => {
    const t = useToastStore();
    t.push({ title: "Hello" });
    t.push({ title: "World" });
    expect(t.items.length).toBe(2);
    expect(t.items[0].id).not.toBe(t.items[1].id);
  });

  it("dismiss removes the item by id", () => {
    const t = useToastStore();
    const id = t.push({ title: "bye" });
    expect(t.items.length).toBe(1);
    t.dismiss(id);
    expect(t.items.length).toBe(0);
  });

  it("auto-dismisses after the configured timeout", () => {
    const t = useToastStore();
    t.push({ title: "x", timeout: 1000 });
    expect(t.items.length).toBe(1);
    vi.advanceTimersByTime(1500);
    expect(t.items.length).toBe(0);
  });

  it("caps the visible stack at MAX_TOASTS by dropping the oldest", () => {
    const t = useToastStore();
    for (let i = 0; i < 12; i += 1) {
      t.push({ title: `t${i}` });
    }
    expect(t.items.length).toBe(8);
    // The oldest 4 should have been shifted off; the surviving stack
    // should start at t4 and end at t11.
    expect(t.items[0].title).toBe("t4");
    expect(t.items.at(-1)?.title).toBe("t11");
  });
});