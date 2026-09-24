<script setup lang="ts">
import { computed } from "vue";
import { renderMarkdown } from "@/lib/markdown";

const props = defineProps<{
  source: string;
}>();

const html = computed(() => renderMarkdown(props.source));
</script>

<template>
  <div class="markdown-body text-sm" v-html="html" />
</template>

<style scoped>
.markdown-body :deep(code) {
  white-space: pre-wrap;
  word-break: break-word;
}
.markdown-body :deep(pre code) {
  white-space: pre;
}
.markdown-body :deep(table) {
  border-collapse: collapse;
}
.markdown-body :deep(blockquote) > :first-child {
  margin-top: 0;
}
.markdown-body :deep(blockquote) > :last-child {
  margin-bottom: 0;
}
.markdown-body :deep(p):first-child {
  margin-top: 0;
}
.markdown-body :deep(p):last-child {
  margin-bottom: 0;
}
</style>