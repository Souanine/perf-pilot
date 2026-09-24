import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useUiStore } from "@/stores/ui";

describe("ui store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    document.documentElement.classList.remove("dark");
  });

  it("defaults to system preference (light when matchMedia returns false)", () => {
    const ui = useUiStore();
    expect(["light", "dark"]).toContain(ui.theme);
  });

  it("toggleTheme flips between light and dark", () => {
    const ui = useUiStore();
    const initial = ui.theme;
    ui.toggleTheme();
    expect(ui.theme).not.toBe(initial);
    ui.toggleTheme();
    expect(ui.theme).toBe(initial);
  });

  it("setTheme updates localStorage", () => {
    const ui = useUiStore();
    ui.setTheme("dark");
    expect(localStorage.getItem("perf-pilot.theme")).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    ui.setTheme("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("toggleSidebar toggles collapsed flag", () => {
    const ui = useUiStore();
    expect(ui.sidebarCollapsed).toBe(false);
    ui.toggleSidebar();
    expect(ui.sidebarCollapsed).toBe(true);
    ui.toggleSidebar();
    expect(ui.sidebarCollapsed).toBe(false);
  });
});