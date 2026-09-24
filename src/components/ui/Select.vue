<script setup lang="ts">
import { computed } from "vue";
import { cn } from "@/lib/utils";

export interface SelectOption {
  label: string;
  value: string;
}

const props = withDefaults(
  defineProps<{
    modelValue?: string;
    options: SelectOption[];
    class?: string;
    placeholder?: string;
    disabled?: boolean;
  }>(),
  { modelValue: "" },
);
const emit = defineEmits<{ (e: "update:modelValue", value: string): void }>();
const cls = computed(() =>
  cn(
    "flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
    props.class,
  ),
);
</script>

<template>
  <select
    :class="cls"
    :value="modelValue"
    :disabled="disabled"
    @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
  >
    <option v-if="placeholder" value="" disabled hidden>{{ placeholder }}</option>
    <option v-for="opt in options" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
  </select>
</template>