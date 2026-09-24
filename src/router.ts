import { createRouter, createWebHashHistory, type RouteRecordRaw } from "vue-router";

const routes: RouteRecordRaw[] = [
  { path: "/", redirect: "/dashboard" },
  {
    path: "/dashboard",
    name: "dashboard",
    component: () => import("@/pages/DashboardPage.vue"),
    meta: { title: "Dashboard" },
  },
  {
    path: "/editor",
    name: "editor",
    component: () => import("@/pages/ScriptEditorPage.vue"),
    meta: { title: "Script Editor" },
  },
  {
    path: "/ai",
    name: "ai",
    component: () => import("@/pages/AIGeneratePage.vue"),
    meta: { title: "AI Generate" },
  },
  {
    path: "/runs",
    name: "runs",
    component: () => import("@/pages/RunsPage.vue"),
    meta: { title: "Runs" },
  },
  {
    path: "/history",
    name: "history",
    component: () => import("@/pages/HistoryPage.vue"),
    meta: { title: "History" },
  },
  {
    path: "/settings",
    name: "settings",
    component: () => import("@/pages/SettingsPage.vue"),
    meta: { title: "LLM Settings" },
  },
  {
    path: "/:catchAll(.*)",
    redirect: "/dashboard",
  },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});