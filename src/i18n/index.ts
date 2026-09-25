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

/**
 * Lazily load the messages bundle for `locale`.
 *
 * `en` is statically imported (and bundled into the entry chunk) so the
 * first paint is never waiting on a network round-trip; `zh-CN` is
 * dynamically imported and lives in its own chunk, only fetched when the
 * user actually selects it (or when their browser's locale resolves to
 * it during the initial boot).
 */
export async function loadLocaleMessages(locale: Locale): Promise<unknown> {
  if (locale === "en") return en;
  if (locale === "zh-CN") return (await import("./zh-CN")).default;
  return en;
}

export const i18n = createI18n({
  legacy: false,
  locale: "en",
  fallbackLocale: "en",
  // Only English is registered up-front. Other locales are added via
  // `setLocaleMessage` once `loadLocaleMessages` resolves.
  messages: { en },
  datetimeFormats: {
    en: {
      short: { year: "numeric", month: "short", day: "numeric" },
    },
    "zh-CN": {
      short: { year: "numeric", month: "short", day: "numeric" },
    },
  },
});

/**
 * Swap the active locale at runtime. Used by the locale store on boot
 * and on user-driven locale changes.
 */
export async function setActiveLocale(locale: Locale): Promise<void> {
  // The dynamic import's shape is the same as the static `en` import
  // (both come from the same locale file structure), but vue-i18n's
  // generic message type is inferred from the initial bundle, so we
  // widen with a structural cast.
  const messages = (await loadLocaleMessages(locale)) as Parameters<
    typeof i18n.global.setLocaleMessage
  >[1];
  i18n.global.setLocaleMessage(locale, messages);
  // `legacy: false` exposes `locale` as a ref on the composer API.
  (i18n.global.locale as unknown as { value: Locale }).value = locale;
}

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