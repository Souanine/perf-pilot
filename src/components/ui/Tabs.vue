<script setup lang="ts">
import { computed } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: string }>();
const cls = computed(() => cn("flex flex-col gap-2", props.class));
</script>

<template>
  <div :class="cls">
    <slot />
  </div>
</template>