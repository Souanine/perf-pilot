<script setup lang="ts">
import { cn } from "@/lib/utils";
import { computed } from "vue";
const props = defineProps<{ class?: string; active?: boolean; value: string }>();
const emit = defineEmits<{ (e: "select", value: string): void }>();
const cls = computed(() =>
  cn(
    "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
    props.active
      ? "bg-background text-foreground shadow"
      : "hover:bg-background/60 hover:text-foreground",
    props.class,
  ),
);
</script>
<template>
  <button :class="cls" :data-value="value" role="tab" @click="emit('select', value)">
    <slot />
  </button>
</template>