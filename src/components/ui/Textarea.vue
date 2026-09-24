<script setup lang="ts">
import { cn } from "@/lib/utils";
import { computed } from "vue";
const props = defineProps<{
  class?: string;
  modelValue?: string;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
}>();
const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
}>();
const cls = computed(() =>
  cn(
    "flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
    props.class,
  ),
);
</script>
<template>
  <textarea
    :class="cls"
    :rows="rows ?? 4"
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
  />
</template>