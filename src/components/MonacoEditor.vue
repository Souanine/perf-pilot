<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as monaco from "monaco-editor";

// Wire up Monaco's web workers via Vite (MonacoEnvironment is set in src-vue-bootstrap).
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

(self as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

const props = withDefaults(
  defineProps<{
    modelValue: string;
    language?: string;
    theme?: "vs-dark" | "vs" | "hc-black";
    height?: string;
    readOnly?: boolean;
  }>(),
  { language: "javascript", theme: "vs-dark", height: "100%", readOnly: false },
);

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
}>();

const hostRef = ref<HTMLDivElement | null>(null);
let editor: monaco.editor.IStandaloneCodeEditor | null = null;

onMounted(() => {
  if (!hostRef.value) return;
  editor = monaco.editor.create(hostRef.value, {
    value: props.modelValue,
    language: props.language,
    theme: props.theme,
    automaticLayout: true,
    minimap: { enabled: true },
    fontSize: 13,
    fontFamily:
      'JetBrains Mono, "Fira Code", Menlo, Monaco, Consolas, monospace',
    tabSize: 2,
    smoothScrolling: true,
    scrollBeyondLastLine: false,
    wordWrap: "on",
    readOnly: props.readOnly,
    renderLineHighlight: "all",
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: true, indentation: true },
  });

  editor.onDidChangeModelContent(() => {
    if (!editor) return;
    const val = editor.getValue();
    if (val !== props.modelValue) emit("update:modelValue", val);
  });
});

watch(
  () => props.modelValue,
  (val) => {
    if (editor && editor.getValue() !== val) editor.setValue(val);
  },
);

watch(
  () => props.theme,
  (val) => monaco.editor.setTheme(val),
);

watch(
  () => props.readOnly,
  (val) => {
    if (editor) editor.updateOptions({ readOnly: val });
  },
);

onBeforeUnmount(() => {
  if (editor) {
    editor.dispose();
    editor = null;
  }
});

defineExpose({
  getEditor: () => editor,
});
</script>

<template>
  <div ref="hostRef" class="monaco-host" :style="{ height }"></div>
</template>