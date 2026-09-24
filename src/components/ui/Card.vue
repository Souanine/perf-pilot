<script setup lang="ts">
import { cn } from "@/lib/utils";
import { computed } from "vue";

const props = defineProps<{ class?: string }>();
const cls = computed(() => cn("rounded-lg border bg-card text-card-foreground shadow-sm", props.class));
</script>

<template>
  <div :class="cls">
    <slot />
  </div>
</template>