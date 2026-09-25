/**
 * Minimal POSIX-ish shell-style tokenizer.
 *
 * Used by the RunsPage env-vars / CLI-args inputs. The naive
 * `split(/\s+/)` approach breaks the moment a value contains a space,
 * an `&` (URL query separator), or anything else the user wants to
 * keep literal — the most common case being `BASE_URL="https://…?a=1&b=2"`.
 *
 * Grammar (matches what users actually type in shell commands):
 *   - Words are separated by whitespace outside quotes.
 *   - Single quotes: literal, no escape processing inside.
 *   - Double quotes: literal except `\"` and `\\` and `\$`.
 *   - Backslash outside any quote escapes the next character.
 *   - Empty input → empty array. Unbalanced quote → still returns
 *     whatever was collected so far (lenient; the user can fix the
 *     input on the next keystroke rather than getting stuck).
 */

export function shellSplit(input: string): string[] {
  const tokens: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let hasContent = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];

    if (escaped) {
      buf += c;
      escaped = false;
      hasContent = true;
      continue;
    }
    if (c === "\\" && !inSingle) {
      // Backslash outside single quotes escapes the next char.
      // Inside single quotes it's literal.
      escaped = true;
      continue;
    }
    if (inSingle) {
      if (c === "'") {
        inSingle = false;
      } else {
        buf += c;
      }
      continue;
    }
    if (inDouble) {
      if (c === '"') {
        inDouble = false;
      } else {
        buf += c;
      }
      continue;
    }
    // Not currently in a quote.
    if (c === "'") {
      inSingle = true;
      hasContent = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      hasContent = true;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n") {
      if (hasContent) {
        tokens.push(buf);
        buf = "";
        hasContent = false;
      }
      continue;
    }
    buf += c;
    hasContent = true;
  }
  if (hasContent) tokens.push(buf);
  return tokens;
}

/**
 * Parse `KEY=VALUE` lines, one per line. Honors shell-style quoting
 * around the VALUE side so `TOKEN="abc def"` is preserved verbatim.
 * Returns the entries in document order.
 */
export function parseEnvLines(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of input.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const valueWithMaybeQuotes = line.slice(eq + 1);
    // Run the value side through the tokenizer — it leaves a
    // single-quoted or double-quoted value untouched, which is what
    // we want here. If the user wrote `KEY=foo bar` (unquoted, with
    // whitespace) we keep only the first token, matching POSIX export.
    const tokens = shellSplit(valueWithMaybeQuotes);
    out[key] = tokens.join(" ");
  }
  return out;
}
