import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api, type AppInfo } from "@/lib/tauri";

export const useAppStore = defineStore("app", () => {
  const info = ref<AppInfo | null>(null);
  const loaded = ref(false);

  async function load() {
    try {
      await api.ensureDirs();
      info.value = await api.getAppInfo();
    } catch (e) {
      console.error("getAppInfo failed", e);
    } finally {
      loaded.value = true;
    }
  }

  const k6Available = computed(() => Boolean(info.value?.k6_info));

  return { info, loaded, k6Available, load };
});