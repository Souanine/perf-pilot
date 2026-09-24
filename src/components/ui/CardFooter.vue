<script setup lang="ts">
import { cn } from "@/lib/utils";
import { computed } from "vue";
const props = defineProps<{ class?: string }>();
const cls = computed(() => cn("flex items-center p-6 pt-0", props.class));
</script>
<template><div :class="cls"><slot /></div></template>