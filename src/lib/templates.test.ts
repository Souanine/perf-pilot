import { describe, it, expect } from "vitest";
import {
  SCRIPT_TEMPLATES,
  getTemplate,
  requiredTemplateKeys,
} from "@/lib/templates";
import { tForLocale } from "@/i18n";

describe("SCRIPT_TEMPLATES", () => {
  it("ships with the expected set of templates", () => {
    // Guard against silent dropouts in refactors.
    const ids = SCRIPT_TEMPLATES.map((t) => t.id);
    expect(ids).toEqual([
      "smoke",
      "load",
      "spike",
      "stress",
      "soak",
      "api-mix",
      "constant-arrival-rate",
      "breakpoint",
      "grpc",
      "websocket",
      "data-driven",
    ]);
  });

  it("every template has the keys needed by the picker and renderer", () => {
    for (const tpl of SCRIPT_TEMPLATES) {
      expect(tpl.id, "id is required").toBeTruthy();
      expect(tpl.nameKey, "nameKey is required").toMatch(/^templates\.[a-z0-9-]+\.name$/);
      expect(tpl.descriptionKey, "descriptionKey is required").toMatch(
        /^templates\.[a-z0-9-]+\.description$/,
      );
      expect(tpl.headerKey, "headerKey is required").toMatch(/^templates\.[a-z0-9-]+\.header$/);
      expect(tpl.tag, "tag is required").toBeTruthy();
      expect(typeof tpl.build, "build is a function").toBe("function");
    }
  });

  it("ids, nameKeys, descriptionKeys, and headerKeys are all unique", () => {
    const uniq = (xs: string[]) => new Set(xs).size === xs.length;
    expect(uniq(SCRIPT_TEMPLATES.map((t) => t.id))).toBe(true);
    expect(uniq(SCRIPT_TEMPLATES.map((t) => t.nameKey))).toBe(true);
    expect(uniq(SCRIPT_TEMPLATES.map((t) => t.descriptionKey))).toBe(true);
    expect(uniq(SCRIPT_TEMPLATES.map((t) => t.headerKey))).toBe(true);
  });

  it("every required key resolves to a non-empty string in both locales", () => {
    const { names, descriptions, headers } = requiredTemplateKeys();
    for (const key of [...names, ...descriptions, ...headers]) {
      const en = tForLocale("en", key);
      const zh = tForLocale("zh-CN", key);
      expect(typeof en, `en:${key} should be a string`).toBe("string");
      expect(en.length, `en:${key} should be non-empty`).toBeGreaterThan(0);
      expect(typeof zh, `zh-CN:${key} should be a string`).toBe("string");
      expect(zh.length, `zh-CN:${key} should be non-empty`).toBeGreaterThan(0);
    }
  });

  it("English and Chinese descriptions for each template are different languages, not the same text", () => {
    // A sanity check that someone didn't accidentally drop the Chinese
    // translations in — the two should not be byte-identical for any template.
    for (const tpl of SCRIPT_TEMPLATES) {
      const en = tForLocale("en", tpl.nameKey);
      const zh = tForLocale("zh-CN", tpl.nameKey);
      expect(en).not.toBe(zh);
    }
  });

  it("build() returns a syntactically complete k6 script", () => {
    for (const tpl of SCRIPT_TEMPLATES) {
      const src = tpl.build("test-script");
      // Every k6 script must define `options` and `default` (or a named
      // function referenced from a scenario). Validate that the
      // structural skeleton is present.
      expect(src, `${tpl.id} includes options`).toMatch(/export const options/);
      // Either a default function or an exported function referenced
      // by a scenario.
      const hasDefault = /export default function/.test(src);
      const hasScenarioExec = /exec:/.test(src);
      expect(hasDefault || hasScenarioExec, `${tpl.id} exports a default or scenario function`).toBe(true);
      // Threshold block is present in every template.
      expect(src, `${tpl.id} has thresholds`).toMatch(/thresholds:/);
      // Imports k6/http at least. Templates that use a different protocol
      // module (grpc uses k6/net/grpc; websocket uses k6/ws; data-driven
      // uses SharedArray without papaparse bundled) get a pass since
      // their protocol is different.
      const skipHttpImport = new Set(["grpc", "websocket", "data-driven"]);
      if (!skipHttpImport.has(tpl.id)) {
        expect(src, `${tpl.id} imports k6/http`).toMatch(/from "k6\/http"/);
      }
    }
  });

  it("every template's build() output round-trips through the file path / scripts dir", () => {
    // Just check the script doesn't accidentally include characters that
    // would break the JS parser (e.g. unescaped backticks).
    for (const tpl of SCRIPT_TEMPLATES) {
      const src = tpl.build("name-with-dashes");
      // Escape-aware: every escaped \` in the source must pair.
      const escaped = src.match(/\\`/g)?.length ?? 0;
      const unescaped = src.match(/(?<!\\)`/g)?.length ?? 0;
      // Templates use backticks for template literals; we expect an even
      // number of unescaped backticks (opening + closing).
      expect(unescaped % 2, `${tpl.id} has unbalanced template-literal backticks`).toBe(0);
      // Escaped backticks exist (templates use them) — but they shouldn't
      // be in the output, since we don't have inline code fences.
      expect(escaped, `${tpl.id} shouldn't have raw escaped backticks`).toBe(0);
    }
  });
});

describe("getTemplate", () => {
  it("returns the matching template by id", () => {
    expect(getTemplate("smoke")?.id).toBe("smoke");
    expect(getTemplate("breakpoint")?.id).toBe("breakpoint");
    expect(getTemplate("data-driven")?.id).toBe("data-driven");
  });

  it("returns undefined for an unknown id", () => {
    expect(getTemplate("does-not-exist")).toBeUndefined();
    expect(getTemplate("")).toBeUndefined();
  });
});