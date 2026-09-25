import { defineStore } from "pinia";
import { ref, watch } from "vue";

const THEME_KEY = "perf-pilot.theme";
const SIDEBAR_KEY = "perf-pilot.sidebar-collapsed";

function loadStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function persistStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // localStorage may be disabled (private mode, quota); the in-memory
    // ref still works for the current session.
  }
}

function loadTheme(): "light" | "dark" {
  const stored = loadStored(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export const useUiStore = defineStore("ui", () => {
  const theme = ref<"light" | "dark">(loadTheme());
  const sidebarCollapsed = ref<boolean>(
    loadStored(SIDEBAR_KEY) === "1",
  );

  function applyTheme(value: "light" | "dark") {
    const html = document.documentElement;
    if (value === "dark") {
      html.classList.add("dark");
    } else {
      html.classList.remove("dark");
    }
  }

  function setTheme(value: "light" | "dark") {
    theme.value = value;
    applyTheme(value);
    persistStored(THEME_KEY, value);
  }

  function toggleTheme() {
    setTheme(theme.value === "dark" ? "light" : "dark");
  }

  function toggleSidebar() {
    sidebarCollapsed.value = !sidebarCollapsed.value;
  }

  watch(
    theme,
    (val) => {
      applyTheme(val);
    },
    { immediate: true },
  );

  watch(sidebarCollapsed, (val) => {
    persistStored(SIDEBAR_KEY, val ? "1" : "0");
  });

  return {
    theme,
    sidebarCollapsed,
    setTheme,
    toggleTheme,
    toggleSidebar,
  };
});