import { defineStore } from "pinia";
import { computed, ref } from "vue";
import {
  api,
  type CredentialBrief,
  type CredentialMode,
} from "@/lib/tauri";
import { getSettingsStore as getStore } from "@/lib/settings-store";

/** Metadata list key in `perf-pilot.settings.json`. Rust reads the same key
 *  (`CREDENTIALS_KEY` in src-tauri/src/credentials.rs) at k6 spawn time;
 *  the frontend owns all writes, same contract as `scripts.dir`. */
const KEY_CREDENTIALS = "credentials.list";
const KEY_LAST_SELECTED = "credentials.lastSelected";

/** Secret values themselves live in the OS credential store under
 *  `cred:<id>:<index>` (one entry per pool value) and never appear here. */
export interface CredentialMeta {
  id: string;
  name: string;
  mode: CredentialMode;
  /** Env var name (or `OAUTH`-style prefix for oauth2 modes). */
  envKey: string;
  userEnvKey?: string;
  passEnvKey?: string;
  headerName?: string;
  location?: "header" | "query";
  tokenUrl?: string;
  scope?: string;
  /** basic mode: usernames, parallel to the password pool. Non-secret. */
  users?: string[];
  /** Number of secret values currently held in the keychain pool. */
  valueCount: number;
}

/** Draft as edited in the UI. `values` is the secret pool: `null` means
 *  "leave the stored pool untouched" (edit with the secret field blank). */
export interface CredentialDraft {
  id?: string;
  name: string;
  mode: CredentialMode;
  envKey: string;
  userEnvKey?: string;
  passEnvKey?: string;
  headerName?: string;
  location?: "header" | "query";
  tokenUrl?: string;
  scope?: string;
  users?: string[];
  values: string[] | null;
}

/** Rust's `validate_id` allows `[A-Za-z0-9_-]{1,128}`; ids land inside
 *  keychain entry names, so keep to that alphabet. */
function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return "cred-" + crypto.randomUUID();
  }
  return "cred-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** Env var names reach a child process environment; mirror Rust's
 *  `validate_env_key` so the form rejects bad names before the keychain
 *  write would fail at run time. */
export function isValidEnvKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key);
}

function sanitizeMeta(d: CredentialDraft, valueCount: number): CredentialMeta {
  const meta: CredentialMeta = {
    id: d.id ?? newId(),
    name: d.name.trim(),
    mode: d.mode,
    envKey: d.envKey.trim(),
    valueCount,
  };
  if (d.mode === "basic") {
    meta.userEnvKey = d.userEnvKey?.trim() || "AUTH_USER";
    meta.passEnvKey = d.passEnvKey?.trim() || "AUTH_PASS";
    meta.users = d.users ?? [];
  }
  if (d.mode === "apikey") {
    meta.headerName = d.headerName?.trim() || "X-API-Key";
    meta.location = d.location ?? "header";
  }
  if (d.mode === "oauth2_client" || d.mode === "oauth2_refresh") {
    meta.tokenUrl = d.tokenUrl?.trim() || undefined;
    if (d.mode === "oauth2_client" && d.scope?.trim()) {
      meta.scope = d.scope.trim();
    }
  }
  return meta;
}

export const useCredentialsStore = defineStore("credentials", () => {
  const items = ref<CredentialMeta[]>([]);
  /** Credential ids auto-ticked on the Runs page for the next run. */
  const lastSelected = ref<string[]>([]);
  const ready = ref(false);
  /** Set when a keychain write failed — surfaced as a toast by callers. */
  const storeError = ref<string | null>(null);

  /** Metadata-only view for the AI page — never includes values. */
  const briefs = computed<CredentialBrief[]>(() =>
    items.value.map((m) => ({
      name: m.name,
      mode: m.mode,
      envKey: m.envKey,
      userEnvKey: m.userEnvKey ?? null,
      passEnvKey: m.passEnvKey ?? null,
      headerName: m.headerName ?? null,
      location: m.location ?? null,
      tokenUrl: m.tokenUrl ?? null,
      scope: m.scope ?? null,
      valueCount: m.valueCount,
    })),
  );

  async function hydrate() {
    const s = await getStore();
    const stored = await s.get<unknown[]>(KEY_CREDENTIALS);
    if (Array.isArray(stored)) {
      items.value = stored.filter(
        (x): x is CredentialMeta =>
          !!x && typeof x === "object" && typeof (x as CredentialMeta).id === "string",
      );
    }
    const storedSel = await s.get<string[]>(KEY_LAST_SELECTED);
    if (Array.isArray(storedSel)) {
      // Drop ids whose credential has since been deleted.
      const ids = new Set(items.value.map((m) => m.id));
      lastSelected.value = storedSel.filter((id) => ids.has(id));
    }
    ready.value = true;
  }

  async function persist() {
    const s = await getStore();
    await s.set(KEY_CREDENTIALS, items.value);
    await s.set(KEY_LAST_SELECTED, lastSelected.value);
    await s.save();
  }

  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  function schedulePersist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persist().catch((e) => console.error("persist credentials failed", e));
    }, 300);
  }

  /** Deterministic flush for tests and import flows. */
  async function flushPersist() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    await persist();
  }

  /**
   * Create or update a credential. When `draft.values` carries values they
   * are written to the keychain first — if that write fails the metadata is
   * left untouched and the error is rethrown, so the JSON never claims a
   * pool that isn't in the store. Blank values on an edit means "keep the
   * existing pool".
   */
  async function saveCredential(draft: CredentialDraft): Promise<CredentialMeta> {
    const id = draft.id ?? newId();
    const existing = draft.id
      ? items.value.find((m) => m.id === draft.id)
      : undefined;
    const vals = draft.values ?? [];
    const keepPool = vals.length === 0;
    const valueCount = keepPool ? (existing?.valueCount ?? 0) : vals.length;
    if (!keepPool) {
      try {
        await api.credentialSetValues(id, vals);
        storeError.value = null;
      } catch (e) {
        storeError.value = e instanceof Error ? e.message : String(e);
        throw e;
      }
    }
    const meta = sanitizeMeta({ ...draft, id }, valueCount);
    const idx = items.value.findIndex((m) => m.id === meta.id);
    if (idx >= 0) {
      items.value[idx] = meta;
    } else {
      items.value.push(meta);
    }
    schedulePersist();
    return meta;
  }

  /** Bulk import path: metadata + values already paired by the parser. */
  async function importCredentials(
    drafts: CredentialDraft[],
  ): Promise<CredentialMeta[]> {
    const saved: CredentialMeta[] = [];
    for (const d of drafts) {
      saved.push(await saveCredential(d));
    }
    await flushPersist();
    return saved;
  }

  async function removeCredential(id: string) {
    items.value = items.value.filter((m) => m.id !== id);
    lastSelected.value = lastSelected.value.filter((x) => x !== id);
    // Best-effort keychain cleanup; the metadata removal already happened.
    api.credentialDelete(id).catch((e) =>
      console.error(`delete keychain pool for credential ${id} failed`, e),
    );
    schedulePersist();
  }

  function isSelected(id: string): boolean {
    return lastSelected.value.includes(id);
  }

  function toggleSelected(id: string) {
    if (lastSelected.value.includes(id)) {
      lastSelected.value = lastSelected.value.filter((x) => x !== id);
    } else {
      lastSelected.value = [...lastSelected.value, id];
    }
    schedulePersist();
  }

  async function ensureHydrated() {
    if (!ready.value) await hydrate();
  }

  return {
    items,
    lastSelected,
    ready,
    storeError,
    briefs,
    hydrate,
    ensureHydrated,
    flushPersist,
    saveCredential,
    importCredentials,
    removeCredential,
    isSelected,
    toggleSelected,
  };
});
