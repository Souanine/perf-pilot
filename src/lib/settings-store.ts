import { load as loadStore, type Store } from "@tauri-apps/plugin-store";

/** The settings JSON has more than one writer (LLM providers, scripts
 *  directory). plugin-store v2 shares the underlying Rust store per
 *  path, but the e2e mock keys by rid and would not — one JS handle for
 *  everyone keeps writes coherent in both environments. */
const STORE_FILE = "perf-pilot.settings.json";

let storeHandle: Store | null = null;

export async function getSettingsStore(): Promise<Store> {
  if (!storeHandle) {
    storeHandle = await loadStore(STORE_FILE, { autoSave: true });
  }
  return storeHandle;
}

/** Key holding the user-chosen scripts directory. Rust reads the same
 *  key from `perf-pilot.settings.json` (see `SCRIPTS_DIR_KEY` in
 *  src-tauri/src/fs.rs); the frontend owns all writes. */
export const KEY_SCRIPTS_DIR = "scripts.dir";
