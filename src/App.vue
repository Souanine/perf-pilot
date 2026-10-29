<script setup lang="ts">
import { onMounted } from "vue";
import AppLayout from "@/components/AppLayout.vue";
import ToastViewport from "@/components/ToastViewport.vue";
import { useAppStore } from "@/stores/app";
import { useScriptsStore } from "@/stores/scripts";
import { useRunsStore } from "@/stores/runs";
import { useLLMStore } from "@/stores/llm";
import { useCredentialsStore } from "@/stores/credentials";
import { useLocaleStore } from "@/stores/locale";
import { useUiStore } from "@/stores/ui";
import { stream as k6Stream } from "@/lib/k6-event-stream";

const app = useAppStore();
const scripts = useScriptsStore();
const runs = useRunsStore();
const llm = useLLMStore();
const credentials = useCredentialsStore();
const locale = useLocaleStore();
const ui = useUiStore();

onMounted(async () => {
  ui.theme;
  // Pull the persisted language preference (or auto-detected default) before
  // any page renders, so the first paint is already in the right locale.
  await locale.hydrate().catch(() => {});
  await app.load();
  await Promise.all([
    scripts.refresh().catch(() => {}),
    runs.refreshHistory().catch(() => {}),
    k6Stream.attach().catch(() => {}),
    llm.hydrate().catch(() => {}),
    credentials.hydrate().catch(() => {}),
  ]);
});
</script>

<template>
  <AppLayout>
    <router-view />
  </AppLayout>
  <ToastViewport />
</template>