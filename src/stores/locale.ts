import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { load as loadStore, type Store } from "@tauri-apps/plugin-store";
import {
  i18n,
  setActiveLocale,
  type Locale,
  SUPPORTED_LOCALES,
  detectLocale,
} from "@/i18n";

const STORE_FILE = "perf-pilot.settings.json";
const KEY_LOCALE = "app.locale";

let storeHandle: Store | null = null;
async function getStore(): Promise<Store> {
  if (!storeHandle) {
    storeHandle = await loadStore(STORE_FILE, { autoSave: true });
  }
  return storeHandle;
}

export const useLocaleStore = defineStore("locale", () => {
  const locale = ref<Locale>(detectLocale());
  const ready = ref(false);

  const isZh = computed(() => locale.value === "zh-CN");
  const supported = SUPPORTED_LOCALES;

  async function hydrate() {
    try {
      const s = await getStore();
      const stored = await s.get<Locale>(KEY_LOCALE);
      if (stored && SUPPORTED_LOCALES.includes(stored)) {
        locale.value = stored;
      }
    } catch (e) {
      // Fallback silently to the detected locale.
      console.warn("locale hydrate failed", e);
    } finally {
      // Reflect in the i18n global — await so the bundle for the active
      // locale is loaded before we declare ready (otherwise the UI
      // briefly renders English strings while zh-CN chunks fetch).
      try {
        await setActiveLocale(locale.value);
      } catch (e) {
        console.warn("setActiveLocale failed", e);
      }
      ready.value = true;
    }
  }

  async function setLocale(next: Locale) {
    if (!SUPPORTED_LOCALES.includes(next)) return;
    locale.value = next;
    await setActiveLocale(next).catch((e) => console.warn("setActiveLocale failed", e));
    try {
      const s = await getStore();
      await s.set(KEY_LOCALE, next);
      await s.save();
    } catch (e) {
      console.warn("locale persist failed", e);
    }
  }

  function toggle() {
    setLocale(isZh.value ? "en" : "zh-CN");
  }

  // Persist any local flips (in case setLocale was awaited in a race).
  // `flush: 'post'` defers until after the DOM has had a chance to
  // update — keeps reactive UI responsive when toggling rapidly.
  watch(locale, (v) => {
    setActiveLocale(v).catch(() => {});
  }, { flush: 'post' });

  return {
    locale,
    supported,
    isZh,
    ready,
    hydrate,
    setLocale,
    toggle,
  };
});