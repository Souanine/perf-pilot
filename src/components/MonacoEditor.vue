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

import { planMonacoSync } from "@/lib/monacoSync";

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

/**
 * Set while *we* are mutating the editor from a `props.modelValue`
 * watch. Without this guard the change event Monaco emits in response
 * to our edit would round-trip back through `emit("update:modelValue")`
 * and re-enter this watcher, looping until the user blinked.
 */
let internalChange = false;

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
    if (internalChange) return;
    if (!editor) return;
    const val = editor.getValue();
    if (val !== props.modelValue) emit("update:modelValue", val);
  });
});

watch(
  () => props.modelValue,
  (val) => {
    if (!editor) return;
    const current = editor.getValue();
    const action = planMonacoSync(current, val);
    if (action.kind === "noop") return;
    internalChange = true;
    try {
      if (action.kind === "append") {
        // Streaming path: append the delta at EOF in a single edit so
        // cursor position and per-edit undo history survive each chunk.
        const model = editor.getModel();
        if (!model) {
          editor.setValue(val);
          return;
        }
        const lineCount = model.getLineCount();
        const lastCol = model.getLineMaxColumn(lineCount);
        const range = {
          startLineNumber: lineCount,
          startColumn: lastCol,
          endLineNumber: lineCount,
          endColumn: lastCol,
        };
        editor.executeEdits("external-stream", [
          { range, text: action.delta, forceMoveMarkers: true },
        ]);
        // Group all streaming chunks into a single undo entry — one
        // Ctrl+Z while editing undoes the whole streamed text rather
        // than one chunk at a time.
        editor.pushUndoStop();
      } else {
        // Full reset (e.g. switching to a freshly generated script).
        editor.setValue(action.value);
      }
    } finally {
      internalChange = false;
    }
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
