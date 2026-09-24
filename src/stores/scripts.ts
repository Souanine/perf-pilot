import { defineStore } from "pinia";
import { ref } from "vue";
import { api, type ScriptFile } from "@/lib/tauri";

export interface ScriptBuffer {
  filePath: string;
  name: string;
  content: string;
  dirty: boolean;
}

export const useScriptsStore = defineStore("scripts", () => {
  const files = ref<ScriptFile[]>([]);
  const buffers = ref<ScriptBuffer[]>([]);
  const activePath = ref<string | null>(null);
  const loading = ref(false);

  async function refresh() {
    loading.value = true;
    try {
      files.value = await api.listScripts();
    } finally {
      loading.value = false;
    }
  }

  async function open(path: string): Promise<ScriptBuffer> {
    const existing = buffers.value.find((b) => b.filePath === path);
    if (existing) {
      activePath.value = path;
      return existing;
    }
    const content = await api.readScript(path);
    const name = path.split(/[\\/]/).pop() ?? path;
    const buf: ScriptBuffer = { filePath: path, name, content, dirty: false };
    buffers.value.push(buf);
    activePath.value = path;
    return buf;
  }

  function closeBuffer(path: string) {
    const idx = buffers.value.findIndex((b) => b.filePath === path);
    if (idx === -1) return;
    buffers.value.splice(idx, 1);
    if (activePath.value === path) {
      activePath.value = buffers.value[0]?.filePath ?? null;
    }
  }

  function setActive(path: string) {
    if (buffers.value.find((b) => b.filePath === path)) {
      activePath.value = path;
    }
  }

  function updateContent(path: string, content: string) {
    const buf = buffers.value.find((b) => b.filePath === path);
    if (!buf) return;
    if (buf.content === content) return;
    buf.content = content;
    buf.dirty = true;
  }

  async function save(path: string): Promise<void> {
    const buf = buffers.value.find((b) => b.filePath === path);
    if (!buf) return;
    await api.writeScript(path, buf.content);
    buf.dirty = false;
    await refresh();
  }

  async function saveAs(path: string, content: string): Promise<string> {
    await api.writeScript(path, content);
    const name = path.split(/[\\/]/).pop() ?? path;
    const idx = buffers.value.findIndex((b) => b.filePath === path);
    const buf: ScriptBuffer = { filePath: path, name, content, dirty: false };
    if (idx === -1) {
      buffers.value.push(buf);
    } else {
      buffers.value[idx] = buf;
    }
    activePath.value = path;
    await refresh();
    return path;
  }

  async function remove(path: string): Promise<void> {
    await api.deleteScript(path);
    closeBuffer(path);
    await refresh();
  }

  return {
    files,
    buffers,
    activePath,
    loading,
    refresh,
    open,
    closeBuffer,
    setActive,
    updateContent,
    save,
    saveAs,
    remove,
  };
});