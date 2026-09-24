import { defineStore } from "pinia";
import { ref } from "vue";

export interface Toast {
  id: string;
  title?: string;
  description?: string;
  variant?: "default" | "success" | "warning" | "destructive" | "info";
  timeout?: number;
}

export const useToastStore = defineStore("toast", () => {
  const items = ref<Toast[]>([]);

  function push(t: Omit<Toast, "id">): string {
    const id = Math.random().toString(36).slice(2);
    const toast: Toast = { id, timeout: 4500, ...t };
    items.value.push(toast);
    if (toast.timeout && toast.timeout > 0) {
      setTimeout(() => dismiss(id), toast.timeout);
    }
    return id;
  }

  function dismiss(id: string) {
    items.value = items.value.filter((t) => t.id !== id);
  }

  return { items, push, dismiss };
});