<script setup lang="ts">
import { cn } from "@/lib/utils";
import { computed } from "vue";
const props = defineProps<{ class?: string; value: string; active?: boolean }>();
const cls = computed(() =>
  cn("mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2", props.class),
);
</script>
<template><div v-show="active" :class="cls" :data-value="value" role="tabpanel"><slot /></div></template>