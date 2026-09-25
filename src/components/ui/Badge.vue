<script setup lang="ts">
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { computed } from "vue";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80",
        outline: "text-foreground",
        success:
          // Higher-contrast palette: 100/800 in light mode keeps WCAG AA
          // for the foreground, and the dark variants push past 7:1.
          "border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200",
        warning:
          "border-transparent bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200",
        info:
          "border-transparent bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

type BadgeVariantProps = VariantProps<typeof badgeVariants>;

const props = withDefaults(
  defineProps<{ variant?: BadgeVariantProps["variant"]; class?: string }>(),
  { variant: "default" },
);
const cls = computed(() => cn(badgeVariants({ variant: props.variant }), props.class));
</script>

<template>
  <div :class="cls">
    <slot />
  </div>
</template>