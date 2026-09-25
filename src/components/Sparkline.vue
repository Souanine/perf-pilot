<script setup lang="ts">
/**
 * Tiny SVG sparkline.
 *
 * Render-only — the heavy lifting (path generation, trend detection,
 * colour choice) lives in `@/lib/sparkline.ts` so it can be unit-tested
 * without mounting an SVG. This component just takes the numbers,
 * runs the pure helpers, and paints the result.
 *
 * Designed for the Dashboard's p(95) / rps / error-rate trends. Won't
 * draw axes, grid lines, or labels — the surrounding Card supplies
 * those.
 */
import { computed } from "vue";
import {
  buildSparklinePath,
  sparklineStroke,
  trendDirection,
  type TrendDirection,
} from "@/lib/sparkline";

const props = withDefaults(
  defineProps<{
    /** Series of values, oldest → newest. nulls render as gaps. */
    values: (number | null | undefined)[];
    /** Metric semantics: drives the up/down → red/green mapping. */
    kind?: "p95" | "rps" | "error";
    /** Pixel size of the SVG viewport. */
    width?: number;
    height?: number;
    /** Override the stroke colour (otherwise chosen by trend). */
    stroke?: string;
    /** Optional aria-label for accessibility. */
    label?: string;
  }>(),
  { kind: "p95", width: 240, height: 60 },
);

const trend: TrendDirection = computed(() => trendDirection(props.values)).value;
const built = computed(() => buildSparklinePath(props.values, props.width, props.height));

const stroke = computed(() =>
  props.stroke ?? sparklineStroke(props.kind, trend),
);

const latest = computed(() => {
  for (let i = props.values.length - 1; i >= 0; i -= 1) {
    const v = props.values[i];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
});
</script>

<template>
  <svg
    :width="width"
    :height="height"
    :viewBox="`0 0 ${width} ${height}`"
    role="img"
    :aria-label="label ?? `${kind} trend`"
    class="text-muted-foreground"
  >
    <path
      v-if="built"
      :d="built.path"
      fill="none"
      :stroke="stroke"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <text
      v-if="latest !== null"
      :x="width - 4"
      :y="12"
      text-anchor="end"
      class="fill-current text-[10px] font-mono"
    >{{ latest.toFixed(kind === 'rps' ? 1 : 0) }}</text>
  </svg>
</template>
