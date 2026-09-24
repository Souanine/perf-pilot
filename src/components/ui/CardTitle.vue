<script setup lang="ts">
import { cn } from "@/lib/utils";
import { computed } from "vue";
const props = defineProps<{ class?: string }>();
const cls = computed(() => cn("text-lg font-semibold leading-none tracking-tight", props.class));
</script>
<template><h3 :class="cls"><slot /></h3></template>