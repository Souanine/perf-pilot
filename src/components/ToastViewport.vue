<script setup lang="ts">
import { computed } from "vue";
import { useToastStore } from "@/stores/toast";
import { CheckCircle2, AlertCircle, AlertTriangle, Info, X } from "lucide-vue-next";
import { cn } from "@/lib/utils";

const toast = useToastStore();
const items = computed(() => toast.items);

function variantClass(v?: string) {
  // Same WCAG-AA palette as Badge.vue — see that file for the
  // rationale behind these specific shades.
  switch (v) {
    case "success":
      return "border-emerald-500/30 bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200";
    case "warning":
      return "border-amber-500/30 bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200";
    case "destructive":
      return "border-red-500/30 bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200";
    case "info":
      return "border-sky-500/30 bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200";
    default:
      return "border-border bg-card text-foreground";
  }
}

function icon(v?: string) {
  switch (v) {
    case "success":
      return CheckCircle2;
    case "warning":
      return AlertTriangle;
    case "destructive":
      return AlertCircle;
    case "info":
      return Info;
    default:
      return Info;
  }
}
</script>

<template>
  <div class="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2">
    <transition-group name="toast">
      <div
        v-for="t in items"
        :key="t.id"
        :class="cn('pointer-events-auto flex w-[360px] items-start gap-3 rounded-lg border p-3 shadow-md backdrop-blur', variantClass(t.variant))"
      >
        <component :is="icon(t.variant)" class="mt-0.5 h-4 w-4 shrink-0" />
        <div class="min-w-0 flex-1">
          <div v-if="t.title" class="text-sm font-semibold">{{ t.title }}</div>
          <div v-if="t.description" class="text-xs opacity-90">{{ t.description }}</div>
        </div>
        <button
          class="rounded p-1 text-muted-foreground hover:bg-background/40"
          @click="toast.dismiss(t.id)"
        >
          <X class="h-3 w-3" />
        </button>
      </div>
    </transition-group>
  </div>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: all 0.2s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>