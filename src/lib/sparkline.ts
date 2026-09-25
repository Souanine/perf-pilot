/**
 * Pure helpers for the Dashboard p(95) / rps / error-rate sparklines.
 *
 * Extracted from the Vue component so they can be unit-tested without
 * mounting an SVG and a Pinia store.
 */

/** Plot a series of `values` into an SVG path string. Skips leading
 *  nulls (an older run might predate the metric field) and trailing
 *  blanks; nulls in the middle are interpolated against their
 *  neighbours so the line doesn't break visually. */
export function buildSparklinePath(
  values: (number | null | undefined)[],
  width: number,
  height: number,
): { path: string; min: number; max: number } | null {
  const finite = values
    .map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null));
  const clean = finite.filter((v): v is number => v !== null);
  if (clean.length < 2) return null;
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  // Avoid divide-by-zero when every value is identical.
  const range = max - min || 1;
  const step = width / (values.length - 1);

  let path = "";
  let first = true;
  for (let i = 0; i < values.length; i += 1) {
    let v = finite[i];
    if (v === null) {
      // Linear-interpolate from the nearest known neighbours.
      v = interpolate(values, i);
      if (v === null) continue;
    }
    const x = i * step;
    const y = height - ((v - min) / range) * height;
    path += first ? `M ${x.toFixed(2)} ${y.toFixed(2)}` : ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
    first = false;
  }
  return { path, min, max };
}

function interpolate(
  values: (number | null | undefined)[],
  i: number,
): number | null {
  // Walk left and right to find the closest known values.
  let leftIdx = i - 1;
  let rightIdx = i + 1;
  while (leftIdx >= 0 && typeof values[leftIdx] !== "number") leftIdx -= 1;
  while (rightIdx < values.length && typeof values[rightIdx] !== "number") rightIdx += 1;
  const left = leftIdx >= 0 ? (values[leftIdx] as number) : null;
  const right = rightIdx < values.length ? (values[rightIdx] as number) : null;
  if (left !== null && right !== null) {
    const t = (i - leftIdx) / (rightIdx - leftIdx);
    return left + (right - left) * t;
  }
  return left ?? right ?? null;
}

/** Classify a metric trend. For p(95) and error-rate, going up is bad;
 *  for rps, going up is good. Returns the semantic direction so the
 *  caller can pick a colour. */
export type TrendDirection = "up" | "down" | "flat" | "unknown";

export function trendDirection(
  values: (number | null | undefined)[],
): TrendDirection {
  const clean = values.filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  if (clean.length < 2) return "unknown";
  const first = clean[0];
  const last = clean[clean.length - 1];
  const delta = last - first;
  const tolerance = Math.max(Math.abs(first), Math.abs(last), 1) * 0.05;
  if (Math.abs(delta) <= tolerance) return "flat";
  return delta > 0 ? "up" : "down";
}

/** Map a metric kind + its trend to a stroke colour. */
export function sparklineStroke(
  kind: "p95" | "rps" | "error",
  dir: TrendDirection,
): string {
  if (dir === "unknown" || dir === "flat") return "currentColor";
  if (kind === "rps") {
    // RPS up = good (green), down = bad (red).
    return dir === "up" ? "rgb(34, 197, 94)" : "rgb(239, 68, 68)";
  }
  // p95 / error: up = bad (red), down = good (green).
  return dir === "up" ? "rgb(239, 68, 68)" : "rgb(34, 197, 94)";
}
