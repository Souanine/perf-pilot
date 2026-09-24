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
});