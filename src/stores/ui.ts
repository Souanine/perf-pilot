import { defineStore } from "pinia";
import { ref, watch } from "vue";

const THEME_KEY = "perf-pilot.theme";

export const useUiStore = defineStore("ui", () => {
  const theme = ref<"light" | "dark">(loadTheme());
  const sidebarCollapsed = ref(false);

  function loadTheme(): "light" | "dark" {
    try {
      const stored = localStorage.getItem(THEME_KEY);
      if (stored === "light" || stored === "dark") return stored;
    } catch {}
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

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
    try {
      localStorage.setItem(THEME_KEY, value);
    } catch {}
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

  return {
    theme,
    sidebarCollapsed,
    setTheme,
    toggleTheme,
    toggleSidebar,
  };
});