import { describe, it, expect } from "vitest";
import { tForLocale, detectLocale, SUPPORTED_LOCALES } from "@/i18n";

describe("i18n module", () => {
  it("exports exactly two supported locales (en, zh-CN)", () => {
    expect(SUPPORTED_LOCALES).toEqual(["en", "zh-CN"]);
  });

  it("detectLocale defaults to en when navigator is unavailable", () => {
    expect(detectLocale()).toBe("en");
  });

  it("tForLocale returns nested string keys", () => {
    expect(tForLocale("en", "nav.dashboard")).toBe("Dashboard");
    expect(tForLocale("zh-CN", "nav.dashboard")).toBe("仪表盘");
  });

  it("tForLocale walks deeply nested keys", () => {
    expect(tForLocale("en", "dashboard.welcome")).toBe("Welcome to PerfPilot");
    expect(tForLocale("zh-CN", "dashboard.welcome")).toBe("欢迎使用 PerfPilot");
  });

  it("tForLocale falls back to the key when the path is missing", () => {
    expect(tForLocale("en", "no.such.key")).toBe("no.such.key");
    expect(tForLocale("zh-CN", "no.such.key")).toBe("no.such.key");
  });

  it("tForLocale respects an explicit fallback argument", () => {
    expect(tForLocale("en", "missing.key", "fallback!")).toBe("fallback!");
  });

  it("Chinese translations exist for every top-level section", () => {
    // Every section key in zh-CN must be a non-empty string.
    const sections = [
      "app",
      "nav",
      "common",
      "status",
      "dashboard",
      "editor",
      "ai",
      "runs",
      "history",
      "settings",
      "report",
      "templates",
    ];
    for (const s of sections) {
      const v = tForLocale("zh-CN", s);
      expect(typeof v, `section ${s} should resolve in zh-CN`).toBe("string");
      expect(v.length, `section ${s} in zh-CN should not be empty`).toBeGreaterThan(0);
    }
  });

  it("every template entry has non-empty name + description in both locales", () => {
    const ids = [
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
    ];
    for (const id of ids) {
      const enName = tForLocale("en", `templates.${id}.name`);
      const zhName = tForLocale("zh-CN", `templates.${id}.name`);
      const enDesc = tForLocale("en", `templates.${id}.description`);
      const zhDesc = tForLocale("zh-CN", `templates.${id}.description`);
      expect(enName.length, `en templates.${id}.name`).toBeGreaterThan(0);
      expect(zhName.length, `zh templates.${id}.name`).toBeGreaterThan(0);
      expect(enDesc.length, `en templates.${id}.description`).toBeGreaterThan(0);
      expect(zhDesc.length, `zh templates.${id}.description`).toBeGreaterThan(0);
    }
  });

  it("report section keys exist in both locales", () => {
    expect(tForLocale("en", "report.title")).toBe("Performance Report");
    expect(tForLocale("zh-CN", "report.title")).toBe("性能报告");
    expect(tForLocale("en", "report.generate")).toBe("Generate report");
    expect(tForLocale("zh-CN", "report.generate")).toBe("生成报告");
    expect(tForLocale("en", "report.regenerate")).toBe("Regenerate report");
    expect(tForLocale("zh-CN", "report.regenerate")).toBe("重新生成报告");
    expect(tForLocale("en", "report.download")).toBe("Download .md");
    expect(tForLocale("zh-CN", "report.download")).toBe("下载 .md");
    expect(tForLocale("en", "report.empty")).toContain("Generate");
    expect(tForLocale("zh-CN", "report.empty")).toContain("生成");
  });
});