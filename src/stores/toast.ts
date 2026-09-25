import { defineStore } from "pinia";
import { ref } from "vue";

export interface Toast {
  id: string;
  title?: string;
  description?: string;
  variant?: "default" | "success" | "warning" | "destructive" | "info";
  timeout?: number;
}

/** Hard cap on simultaneously visible toasts. LLM runs and bursty
 *  error streams can otherwise flood the viewport with a tower of
 *  cards that hides the page underneath. When the cap is hit, the
 *  oldest toast is dropped — newer messages are always more
 *  relevant than the ones the user already saw. */
const MAX_TOASTS = 8;

export const useToastStore = defineStore("toast", () => {
  const items = ref<Toast[]>([]);

  function push(t: Omit<Toast, "id">): string {
    const id = crypto.randomUUID();
    const toast: Toast = { id, timeout: 4500, ...t };
    items.value.push(toast);
    if (toast.timeout && toast.timeout > 0) {
      setTimeout(() => dismiss(id), toast.timeout);
    }
    // Drop overflow from the front (oldest first) until we're at the cap.
    while (items.value.length > MAX_TOASTS) {
      items.value.shift();
    }
    return id;
  }

  function dismiss(id: string) {
    items.value = items.value.filter((t) => t.id !== id);
  }

  return { items, push, dismiss };
});