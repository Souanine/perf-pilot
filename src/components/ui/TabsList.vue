<script setup lang="ts">
import { cn } from "@/lib/utils";
import { computed } from "vue";
const props = defineProps<{ class?: string }>();
const cls = computed(() =>
  cn(
    "inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground",
    props.class,
  ),
);
</script>
<template><div :class="cls" role="tablist"><slot /></div></template>