import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useLocaleStore } from "@/stores/locale";

describe("locale store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("starts on the auto-detected locale", () => {
    const s = useLocaleStore();
    expect(["en", "zh-CN"]).toContain(s.locale);
  });

  it("setLocale changes the active locale", async () => {
    const s = useLocaleStore();
    await s.setLocale("zh-CN");
    expect(s.locale).toBe("zh-CN");
    expect(s.isZh).toBe(true);
  });

  it("toggle alternates between en and zh-CN", async () => {
    const s = useLocaleStore();
    const before = s.locale;
    await s.toggle();
    expect(s.locale).not.toBe(before);
    await s.toggle();
    expect(s.locale).toBe(before);
  });

  it("setLocale rejects unknown ids", async () => {
    const s = useLocaleStore();
    const before = s.locale;
    // @ts-expect-error — intentional bad input
    await s.setLocale("fr-FR");
    expect(s.locale).toBe(before);
  });
});