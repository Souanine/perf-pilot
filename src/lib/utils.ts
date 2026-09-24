import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { RunOutput } from "./tauri";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)}s`;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}m ${rem.toFixed(0)}s`;
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 0) return new Date(iso).toLocaleString();
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/** Convert a RunOutput to a Markdown report suitable for sharing/posting in PRs. */
export function runToMarkdown(run: RunOutput): string {
  const started = new Date(run.started_at).toLocaleString();
  const finished = run.finished_at
    ? new Date(run.finished_at).toLocaleString()
    : "(not finished)";
  const exit = run.exit_code !== null ? run.exit_code : "—";
  const lines: string[] = [];
  lines.push(`# k6 run — ${run.label || run.script_path.split(/[\\/]/).pop()}`);
  lines.push("");
  lines.push(`- **Status:** \`${run.status}\``);
  lines.push(`- **Run ID:** \`${run.run_id}\``);
  lines.push(`- **Script:** \`${run.script_path}\``);
  lines.push(`- **Started:** ${started}`);
  lines.push(`- **Finished:** ${finished}`);
  lines.push(`- **Exit code:** \`${exit}\``);
  if (run.error) {
    lines.push(`- **Error:** ${run.error}`);
  }
  lines.push("");

  if (run.metrics.length) {
    lines.push("## Summary metrics");
    lines.push("");
    lines.push("| Metric | Value |");
    lines.push("| --- | --- |");
    for (const m of run.metrics) {
      lines.push(`| \`${m.name}\` | \`${m.value}\` |`);
    }
    lines.push("");
  }

  if (run.stdout.trim()) {
    lines.push("## stdout");
    lines.push("");
    lines.push("```");
    lines.push(run.stdout.trim());
    lines.push("```");
    lines.push("");
  }

  if (run.stderr.trim()) {
    lines.push("## stderr");
    lines.push("");
    lines.push("```");
    lines.push(run.stderr.trim());
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n");
}