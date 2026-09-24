<script setup lang="ts">
import { cn } from "@/lib/utils";
import { computed } from "vue";
const props = defineProps<{ class?: string; for?: string }>();
const cls = computed(() =>
  cn(
    "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
    props.class,
  ),
);
</script>
<template><label :class="cls" :for="$attrs.for as string | undefined"><slot /></label></template>