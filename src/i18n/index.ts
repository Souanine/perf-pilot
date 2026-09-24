import { createI18n } from "vue-i18n";
import en from "./en";
import zhCN from "./zh-CN";

export type Locale = "en" | "zh-CN";
export const SUPPORTED_LOCALES: Locale[] = ["en", "zh-CN"];

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  "zh-CN": "中文",
};

/** Auto-detect the best supported locale from the browser. */
export function detectLocale(): Locale {
  if (typeof navigator === "undefined") return "en";
  const langs = navigator.languages ?? [navigator.language];
  for (const l of langs) {
    const lower = l.toLowerCase();
    if (lower.startsWith("zh")) return "zh-CN";
    if (lower.startsWith("en")) return "en";
  }
  return "en";
}

export const i18n = createI18n({
  legacy: false,
  locale: "en",
  fallbackLocale: "en",
  messages: {
    en,
    "zh-CN": zhCN,
  },
  // Allow `t('key', n)` style interpolation when needed.
  datetimeFormats: {
    en: {
      short: { year: "numeric", month: "short", day: "numeric" },
    },
    "zh-CN": {
      short: { year: "numeric", month: "short", day: "numeric" },
    },
  },
});

/** Helper for stores / non-component code. */
export function tForLocale(locale: Locale, key: string, fallback?: string): string {
  // Read from a frozen snapshot via the global messages map.
  const messages: Record<string, unknown> =
    locale === "zh-CN" ? (zhCN as unknown as Record<string, unknown>) : (en as unknown as Record<string, unknown>);
  const parts = key.split(".");
  let cur: unknown = messages;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return fallback ?? key;
    }
  }
  return typeof cur === "string" ? cur : (fallback ?? key);
}

export default i18n;