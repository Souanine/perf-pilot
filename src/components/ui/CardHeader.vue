<script setup lang="ts">
import { cn } from "@/lib/utils";
import { computed } from "vue";
const props = defineProps<{ class?: string }>();
const cls = computed(() => cn("flex flex-col space-y-1.5 p-6", props.class));
</script>
<template><div :class="cls"><slot /></div></template>