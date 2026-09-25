import { describe, it, expect } from "vitest";
import {
  buildSparklinePath,
  trendDirection,
  sparklineStroke,
} from "@/lib/sparkline";

describe("buildSparklinePath", () => {
  it("returns null with fewer than two real values", () => {
    expect(buildSparklinePath([], 100, 30)).toBeNull();
    expect(buildSparklinePath([null, null, null], 100, 30)).toBeNull();
    expect(buildSparklinePath([5], 100, 30)).toBeNull();
  });

  it("plots M then L segments for ascending values", () => {
    const out = buildSparklinePath([1, 2, 3], 100, 30);
    expect(out?.path.startsWith("M ")).toBe(true);
    expect(out?.path.split(" L ").length).toBe(3);
  });

  it("interpolates nulls in the middle of the series", () => {
    const out = buildSparklinePath([1, null, 3], 100, 30);
    expect(out?.path).toContain(" L ");
    // Two endpoints + one interpolated point in the middle = 3 nodes.
    expect(out?.path.split(" L ").length).toBe(3);
  });

  it("interpolates leading nulls but doesn't double-plot them", () => {
    const out = buildSparklinePath([null, null, 5, 10], 100, 30);
    expect(out?.path).toContain("M ");
    // 4 positions: two interpolated leading nulls + the two real values.
    expect(out?.path.split(" L ").length).toBe(4);
  });

  it("clamps the y range to the supplied viewport height", () => {
    const out = buildSparklinePath([0, 100], 100, 30);
    // Smallest y (top of the line) should be 0, biggest (bottom) 30.
    const ys = out!.path
      .split(/(?:M|L) /)
      .filter(Boolean)
      .map((p) => parseFloat(p.split(" ")[1]));
    expect(Math.min(...ys)).toBe(0);
    expect(Math.max(...ys)).toBe(30);
  });
});

describe("trendDirection", () => {
  it("reports flat when start and end are within tolerance", () => {
    expect(trendDirection([100, 100, 102])).toBe("flat");
  });

  it("reports up when the series ends above the start", () => {
    expect(trendDirection([10, 12, 20, 30])).toBe("up");
  });

  it("reports down when the series ends below the start", () => {
    expect(trendDirection([100, 80, 60])).toBe("down");
  });

  it("returns unknown with fewer than two real values", () => {
    expect(trendDirection([null, null, 5])).toBe("unknown");
    expect(trendDirection([])).toBe("unknown");
  });

  it("ignores nulls in the middle when computing start/end", () => {
    expect(trendDirection([null, 10, 20, null])).toBe("up");
    expect(trendDirection([50, null, 40])).toBe("down");
  });
});

describe("sparklineStroke", () => {
  it("uses currentColor for unknown / flat trends (no judgement)", () => {
    expect(sparklineStroke("p95", "unknown")).toBe("currentColor");
    expect(sparklineStroke("rps", "flat")).toBe("currentColor");
  });

  it("marks dropping p95/error as green (improvement)", () => {
    expect(sparklineStroke("p95", "down")).toBe("rgb(34, 197, 94)");
    expect(sparklineStroke("error", "down")).toBe("rgb(34, 197, 94)");
  });

  it("marks rising p95/error as red (regression)", () => {
    expect(sparklineStroke("p95", "up")).toBe("rgb(239, 68, 68)");
  });

  it("inverts semantics for rps (up = green)", () => {
    expect(sparklineStroke("rps", "up")).toBe("rgb(34, 197, 94)");
    expect(sparklineStroke("rps", "down")).toBe("rgb(239, 68, 68)");
  });
});
