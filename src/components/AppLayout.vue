<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useLocaleStore } from "@/stores/locale";
import {
  Activity,
  Bot,
  FileCode2,
  Gauge,
  Globe,
  History,
  KeyRound,
  ListChecks,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Sparkles,
  Sun,
  Moon,
} from "@lucide/vue";
import { useUiStore } from "@/stores/ui";
import { useAppStore } from "@/stores/app";
import { LOCALE_LABELS } from "@/i18n";
import Badge from "@/components/ui/Badge.vue";

const ui = useUiStore();
const app = useAppStore();
const localeStore = useLocaleStore();
const { t } = useI18n();
const router = useRouter();
const route = useRoute();

const navItems = [
  { path: "/dashboard", labelKey: "nav.dashboard", icon: Gauge },
  { path: "/editor", labelKey: "nav.editor", icon: FileCode2 },
  { path: "/ai", labelKey: "nav.ai", icon: Sparkles },
  { path: "/runs", labelKey: "nav.runs", icon: Activity },
  { path: "/credentials", labelKey: "nav.credentials", icon: KeyRound },
  { path: "/history", labelKey: "nav.history", icon: History },
  { path: "/settings", labelKey: "nav.settings", icon: Settings },
];

const collapsed = computed(() => ui.sidebarCollapsed);
// Map route path to an i18n key for the in-app page heading. Falls back to
// the router meta title (which is still in English) if no mapping exists.
const ROUTE_TITLE_KEY: Record<string, string> = {
  "/dashboard": "nav.dashboard",
  "/editor": "nav.editor",
  "/ai": "nav.ai",
  "/runs": "nav.runs",
  "/credentials": "nav.credentials",
  "/history": "nav.history",
  "/settings": "nav.settings",
};
const currentTitle = computed(() => {
  const key = ROUTE_TITLE_KEY[route.path];
  if (key) return t(key);
  return (route.meta?.title as string | undefined) ?? "PerfPilot";
});

const k6Label = computed(() => {
  if (!app.k6Available) return "k6: not found";
  return `k6 v${app.info?.k6_info?.version ?? "?"}`;
});
</script>

<template>
  <div class="flex h-full w-full">
    <aside
      :class="[
        'shrink-0 border-r border-border bg-card/40 backdrop-blur-md transition-all duration-200',
        collapsed ? 'w-16' : 'w-60',
      ]"
    >
      <div class="flex h-14 items-center gap-2 border-b border-border px-3">
        <div
          class="grid h-8 w-8 place-items-center rounded-md bg-gradient-to-br from-primary to-primary/60 text-primary-foreground shadow"
        >
          <Bot class="h-4 w-4" />
        </div>
        <div v-if="!collapsed" class="flex flex-col leading-tight">
          <span class="text-sm font-semibold">PerfPilot</span>
          <span class="text-[10px] uppercase tracking-wider text-muted-foreground">AI · k6 · Desktop</span>
        </div>
      </div>
      <nav class="flex flex-col gap-1 p-2">
        <button
          v-for="item in navItems"
          :key="item.path"
          class="flex h-9 items-center gap-3 rounded-md px-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
          :class="[
            route.path === item.path
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground',
          ]"
          @click="router.push(item.path)"
        >
          <component :is="item.icon" class="h-4 w-4 shrink-0" />
          <span v-if="!collapsed">{{ t(item.labelKey) }}</span>
        </button>
      </nav>
      <div class="absolute bottom-0 right-0 hidden lg:block"></div>
    </aside>

    <div class="flex min-w-0 flex-1 flex-col">
      <header
        class="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur"
      >
        <button
          class="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          @click="ui.toggleSidebar()"
          :aria-label="t('nav.toggleSidebar')"
        >
          <component :is="collapsed ? PanelLeftOpen : PanelLeftClose" class="h-4 w-4" />
        </button>
        <h1 class="text-sm font-semibold">{{ currentTitle ?? "PerfPilot" }}</h1>
        <Badge
          :variant="app.k6Available ? 'success' : 'destructive'"
          class="ml-2"
        >
          <ListChecks class="mr-1 h-3 w-3" />
          {{ k6Label }}
        </Badge>
        <div class="ml-auto flex items-center gap-2">
          <Badge variant="info">
            <Gauge class="mr-1 h-3 w-3" /> v{{ app.info?.app_version ?? "0.0.0" }}
          </Badge>
          <div class="relative">
              <select
                :value="localeStore.locale"
                @change="localeStore.setLocale(($event.target as HTMLSelectElement).value as any)"
                :aria-label="t('common.language')"
                class="h-8 rounded-md border border-input bg-background px-2 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option
                  v-for="l in localeStore.supported"
                  :key="l"
                  :value="l"
                >{{ LOCALE_LABELS[l] }}</option>
              </select>
            </div>
          <button
            class="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            :aria-label="t('nav.toggleTheme')"
            @click="ui.toggleTheme()"
          >
            <component :is="ui.theme === 'dark' ? Sun : Moon" class="h-4 w-4" />
          </button>
        </div>
      </header>
      <main class="min-h-0 flex-1 overflow-hidden bg-background">
        <slot />
      </main>
    </div>
  </div>
</template>

<style scoped>
aside {
  position: relative;
}
</style>