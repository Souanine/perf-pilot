<script setup lang="ts">
import { cn } from "@/lib/utils";
import { computed } from "vue";
const props = defineProps<{ class?: string }>();
const cls = computed(() => cn("text-sm text-muted-foreground", props.class));
</script>
<template><p :class="cls"><slot /></p></template>