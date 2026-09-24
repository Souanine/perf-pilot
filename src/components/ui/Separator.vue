<script setup lang="ts">
import { cn } from "@/lib/utils";
import { computed } from "vue";
const props = defineProps<{ class?: string }>();
const cls = computed(() =>
  cn("shrink-0 bg-border h-[1px] w-full", props.class),
);
</script>
<template><div :class="cls" /></template>