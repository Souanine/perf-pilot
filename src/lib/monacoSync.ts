/**
 * Decide how to sync an external `newValue` into a Monaco editor that
 * already shows `oldValue`.
 *
 * Three outcomes:
 *
 *   noop   — editor is already current; skip the watch path entirely.
 *
 *   append — `newValue` extends `oldValue` at the end. This is the hot
 *            path for LLM streaming: applying a single `executeEdits`
 *            with a one-character range at EOF preserves the cursor
 *            position and the per-edit undo history, while `setValue`
 *            would reset both on every chunk.
 *
 *   set    — anything else (e.g. switching to a different script, or
 *            the LLM regenerated from scratch and the prefix changed).
 *            A full `setValue` is the only correct action here.
 *
 * Extracted from MonacoEditor.vue so it can be unit-tested without
 * pulling in Monaco's web workers and canvas.
 */
export type MonacoSyncAction =
  | { kind: "noop" }
  | { kind: "append"; delta: string }
  | { kind: "set"; value: string };

export function planMonacoSync(
  oldValue: string,
  newValue: string,
): MonacoSyncAction {
  if (oldValue === newValue) {
    return { kind: "noop" };
  }
  if (newValue.startsWith(oldValue) && oldValue.length > 0) {
    return { kind: "append", delta: newValue.slice(oldValue.length) };
  }
  return { kind: "set", value: newValue };
}
