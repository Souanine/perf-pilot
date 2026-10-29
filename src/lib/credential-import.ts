/**
 * Parsers for bulk credential import. Three formats, all pure functions so
 * they're unit-testable without a store or keychain:
 *
 * - `.env` / paste: `KEY=VALUE` lines (shell-aware via the same tokenizer
 *   the Runs page env box uses) → one token credential per key.
 * - JSON: array of `{ name, mode?, envKey?, values[], users?, ... }` —
 *   full fidelity for every mode. Values are never exported by the app
 *   (there is no keychain read path), so JSON imports are for hand-written
 *   or third-party sources, not round-trips.
 * - CSV: `user,password` header → one basic pool credential; a single
 *   column → one token pool credential.
 */
import { parseEnvLines } from "@/lib/shellSplit";
import type { CredentialMode } from "@/lib/tauri";

/** One parsed credential ready to hand to `credentials.saveCredential`. */
export interface ImportDraft {
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
  values: string[];
}

export type ImportFormat = "env" | "json" | "csv";

/** Best-effort format sniff for a paste blob / file body. */
export function detectFormat(text: string): ImportFormat {
  const t = text.trim();
  if (t.startsWith("[") || t.startsWith("{")) return "json";
  const firstLine = t.split(/\r?\n/)[0] ?? "";
  if (firstLine.includes(",")) return "csv";
  return "env";
}

/** `KEY=VALUE` lines → one token credential per key. Blank lines and
 *  `#` comments are skipped by `parseEnvLines`. */
export function parseEnvImport(text: string): ImportDraft[] {
  const entries = parseEnvLines(text);
  return Object.entries(entries).map(([key, value]) => ({
    name: key,
    mode: "token" as const,
    envKey: key,
    values: [value],
  }));
}

interface JsonEntry {
  name?: unknown;
  mode?: unknown;
  envKey?: unknown;
  userEnvKey?: unknown;
  passEnvKey?: unknown;
  headerName?: unknown;
  location?: unknown;
  tokenUrl?: unknown;
  scope?: unknown;
  users?: unknown;
  values?: unknown;
}

const VALID_MODES: CredentialMode[] = [
  "token",
  "basic",
  "apikey",
  "oauth2_client",
  "oauth2_refresh",
];

/** oauth2 values are JSON objects on the wire; the vault stores them as
 *  JSON strings, so re-stringify object entries here. */
function normalizeValue(mode: CredentialMode, v: unknown): string | null {
  if (typeof v === "string") return v;
  if (
    (mode === "oauth2_client" || mode === "oauth2_refresh") &&
    v &&
    typeof v === "object"
  ) {
    return JSON.stringify(v);
  }
  return null;
}

/** JSON import: accepts a bare array or `{ credentials: [...] }`. Entries
 *  missing a name or a usable `values` array are skipped, not fatal. */
export function parseJsonImport(text: string): ImportDraft[] {
  const parsed = JSON.parse(text) as unknown;
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { credentials?: unknown })?.credentials)
      ? (parsed as { credentials: unknown[] }).credentials
      : null;
  if (!arr) {
    throw new Error("expected a JSON array of credentials");
  }
  const out: ImportDraft[] = [];
  for (const raw of arr as JsonEntry[]) {
    if (!raw || typeof raw !== "object") continue;
    const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : null;
    if (!name) continue;
    const mode = VALID_MODES.includes(raw.mode as CredentialMode)
      ? (raw.mode as CredentialMode)
      : "token";
    const envKey =
      typeof raw.envKey === "string" && raw.envKey.trim()
        ? raw.envKey.trim()
        : name.toUpperCase().replace(/[^A-Z0-9_]+/g, "_");
    const rawValues = Array.isArray(raw.values) ? raw.values : [];
    const values = rawValues
      .map((v) => normalizeValue(mode, v))
      .filter((v): v is string => v !== null && v !== "");
    if (values.length === 0) continue;
    const draft: ImportDraft = { name, mode, envKey, values };
    if (mode === "basic") {
      draft.userEnvKey =
        typeof raw.userEnvKey === "string" && raw.userEnvKey.trim()
          ? raw.userEnvKey.trim()
          : "AUTH_USER";
      draft.passEnvKey =
        typeof raw.passEnvKey === "string" && raw.passEnvKey.trim()
          ? raw.passEnvKey.trim()
          : "AUTH_PASS";
      draft.users = Array.isArray(raw.users)
        ? raw.users.filter((u): u is string => typeof u === "string")
        : [];
      // A pool without usernames is meaningless for basic auth.
      if (draft.users.length !== values.length) continue;
    }
    if (mode === "apikey") {
      draft.headerName =
        typeof raw.headerName === "string" && raw.headerName.trim()
          ? raw.headerName.trim()
          : "X-API-Key";
      draft.location = raw.location === "query" ? "query" : "header";
    }
    if (mode === "oauth2_client" || mode === "oauth2_refresh") {
      if (typeof raw.tokenUrl === "string" && raw.tokenUrl.trim()) {
        draft.tokenUrl = raw.tokenUrl.trim();
      }
      if (mode === "oauth2_client" && typeof raw.scope === "string" && raw.scope.trim()) {
        draft.scope = raw.scope.trim();
      }
    }
    out.push(draft);
  }
  return out;
}

/** Minimal CSV line tokenizer: handles double-quoted fields (with `""`
 *  escapes) so passwords containing commas survive. Also used by the
 *  Credentials page to parse `user,password` / `id,secret` textareas. */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  fields.push(cur);
  return fields.map((f) => f.trim());
}

/**
 * CSV import. Two-column files with a `user,password` header become one
 * basic pool credential; anything else is treated as a single-column token
 * pool (header row detected and skipped when it looks like a header).
 */
export function parseCsvImport(text: string): ImportDraft[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (lines.length === 0) return [];
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const isUserPass =
    header.length >= 2 && header[0] === "user" && header[1] === "password";
  if (isUserPass) {
    const users: string[] = [];
    const passwords: string[] = [];
    for (const line of lines.slice(1)) {
      const [u, p] = splitCsvLine(line);
      if (u && p) {
        users.push(u);
        passwords.push(p);
      }
    }
    if (users.length === 0) return [];
    return [
      {
        name: "Imported accounts",
        mode: "basic",
        envKey: "AUTH_PASS",
        userEnvKey: "AUTH_USER",
        passEnvKey: "AUTH_PASS",
        users,
        values: passwords,
      },
    ];
  }
  // Single-column token pool. Skip the first line only when it's a known
  // header word — a loose "looks like a word" heuristic would eat real
  // tokens like `tok-a`.
  const looksLikeHeader = /^(tokens?|keys?|values?|api_?keys?|secrets?)$/i.test(lines[0]);
  const rows = looksLikeHeader ? lines.slice(1) : lines;
  if (rows.length === 0) return [];
  return [
    {
      name: "Imported tokens",
      mode: "token",
      envKey: "AUTH_TOKEN",
      values: rows,
    },
  ];
}

/** Sniff + parse in one step. Throws on malformed JSON so the caller can
 *  show a readable error in the import dialog. */
export function parseCredentialImport(text: string, format?: ImportFormat): ImportDraft[] {
  const fmt = format ?? detectFormat(text);
  switch (fmt) {
    case "json":
      return parseJsonImport(text);
    case "csv":
      return parseCsvImport(text);
    default:
      return parseEnvImport(text);
  }
}
