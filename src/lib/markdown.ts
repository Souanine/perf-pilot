/**
 * Tiny, dependency-free Markdown renderer used by the History page to show
 * generated reports. Renders to an HTML string that Vue mounts with v-html.
 *
 * The renderer is intentionally small: it covers headings, paragraphs,
 * lists (ordered + unordered + nested), blockquotes, fenced code blocks,
 * inline code, **bold**, *italic*, [links](url), GFM tables, and horizontal
 * rules. Everything HTML-special in the input is escaped before any tag is
 * emitted, so it's safe to mount via v-html without an extra DOMPurify
 * pass — even if the upstream LLM produces hostile markdown.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

/** Render inline markdown (after escaping) into safe HTML. The input is
 *  expected to already be HTML-escaped. */
function renderInline(escaped: string): string {
  let out = escaped;

  // Inline code first — so we don't apply other formatting inside it.
  const codeSpans: string[] = [];
  const PLACEHOLDER = "§§CODE";
  const PLACEHOLDER_END = "§§";
  out = out.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const idx = codeSpans.length;
    codeSpans.push(`<code class="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">${code}</code>`);
    return `${PLACEHOLDER}${idx}${PLACEHOLDER_END}`;
  });

  // Links: [text](url). Only allow http(s)/mailto schemes so a stray
  // `<javascript:...>` can't smuggle a payload past the renderer.
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, text: string, url: string) => {
      const safe = /^(https?:|mailto:|#|\/|\.)/i.test(url) ? url : "#";
      return `<a class="text-primary underline" href="${escapeAttr(safe)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
  );

  // Bold: **…** or __…__
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");

  // Italic: *…* or _…_ (single, not part of bold)
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  out = out.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>");

  // Restore inline code.
  const re = new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER_END}`, "g");
  out = out.replace(re, (_m, idx: string) => {
    return codeSpans[Number(idx)] ?? "";
  });

  return out;
}

export function renderMarkdown(input: string): string {
  if (!input) return "";

  const text = input.replace(/\r\n/g, "\n");
  const lines = text.split("\n");

  const html: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] || "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(escapeHtml(lines[i]));
        i++;
      }
      i++; // skip closing fence
      const langClass = lang ? ` data-lang="${escapeAttr(lang)}"` : "";
      html.push(
        `<pre class="my-2 overflow-x-auto rounded-md bg-zinc-950 p-3 font-mono text-[12px] leading-relaxed text-emerald-100"${langClass}><code>${body.join("\n")}</code></pre>`,
      );
      continue;
    }

    // Horizontal rule
    if (/^\s{0,3}([-*_])\s*\1\s*\1\s*$/.test(line)) {
      html.push('<hr class="my-3 border-border" />');
      i++;
      continue;
    }

    // Headings
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const content = renderInline(escapeHtml(heading[2].trim()));
      const cls = [
        "text-2xl font-semibold mt-4 mb-2",
        "text-xl font-semibold mt-3 mb-2",
        "text-lg font-semibold mt-3 mb-1",
        "text-base font-semibold mt-2 mb-1",
        "text-sm font-semibold mt-2 mb-1",
        "text-xs font-semibold mt-2 mb-1",
      ][level - 1];
      html.push(`<h${level} class="${cls}">${content}</h${level}>`);
      i++;
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      html.push(
        `<blockquote class="my-2 border-l-2 border-border pl-3 text-muted-foreground italic">${renderInline(escapeHtml(body.join(" ")))}</blockquote>`,
      );
      continue;
    }

    // GFM Table — header row + separator row + optional body rows.
    if (
      /\|/.test(line) &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:-]+(?:\|[\s:-]+)+\|?\s*$/.test(lines[i + 1])
    ) {
      const headerCells = line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim());
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== "") {
        rows.push(
          lines[i]
            .trim()
            .replace(/^\||\|$/g, "")
            .split("|")
            .map((c) => c.trim()),
        );
        i++;
      }
      const thead = `<thead><tr>${headerCells
        .map((c) => `<th class="px-2 py-1 text-left font-semibold">${renderInline(escapeHtml(c))}</th>`)
        .join("")}</tr></thead>`;
      const tbody = rows.length
        ? `<tbody>${rows
            .map(
              (row) =>
                `<tr>${row
                  .map(
                    (c) =>
                      `<td class="border-t border-border px-2 py-1 align-top">${renderInline(escapeHtml(c))}</td>`,
                  )
                  .join("")}</tr>`,
            )
            .join("")}</tbody>`
        : "";
      html.push(
        `<table class="my-2 w-full border border-border text-sm">${thead}${tbody}</table>`,
      );
      continue;
    }

    // Unordered list (with optional nesting via leading spaces).
    if (/^(\s*)[-*+]\s+/.test(line)) {
      const items: { indent: number; html: string }[] = [];
      while (i < lines.length && /^(\s*)[-*+]\s+/.test(lines[i])) {
        const indent = lines[i].search(/\S/);
        const bullet = lines[i].replace(/^(\s*)[-*+]\s+/, "");
        // Collect continuation lines (indented more than the bullet).
        let acc = bullet;
        while (
          i + 1 < lines.length &&
          lines[i + 1].trim() !== "" &&
          !/^(\s*)[-*+]\s+/.test(lines[i + 1]) &&
          !/^(\s*)\d+\.\s+/.test(lines[i + 1]) &&
          !/^#{1,6}\s/.test(lines[i + 1]) &&
          !/^```/.test(lines[i + 1]) &&
          lines[i + 1].search(/\S/) > indent
        ) {
          i++;
          acc += "\n" + lines[i].trim();
        }
        items.push({ indent, html: renderInline(escapeHtml(acc).replace(/\n/g, "<br>")) });
        i++;
      }
      // Render as nested <ul> based on indent depth.
      html.push(renderNestedList(items));
      continue;
    }

    // Ordered list.
    if (/^(\s*)\d+\.\s+/.test(line)) {
      const items: { indent: number; html: string }[] = [];
      while (i < lines.length && /^(\s*)\d+\.\s+/.test(lines[i])) {
        const indent = lines[i].search(/\S/);
        const item = lines[i].replace(/^(\s*)\d+\.\s+/, "");
        let acc = item;
        while (
          i + 1 < lines.length &&
          lines[i + 1].trim() !== "" &&
          !/^(\s*)\d+\.\s+/.test(lines[i + 1]) &&
          !/^(\s*)[-*+]\s+/.test(lines[i + 1]) &&
          !/^#{1,6}\s/.test(lines[i + 1]) &&
          !/^```/.test(lines[i + 1]) &&
          lines[i + 1].search(/\S/) > indent
        ) {
          i++;
          acc += "\n" + lines[i].trim();
        }
        items.push({ indent, html: renderInline(escapeHtml(acc).replace(/\n/g, "<br>")) });
        i++;
      }
      html.push(renderNestedList(items, "ol"));
      continue;
    }

    // Blank line — paragraph break.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph: collect consecutive non-blank, non-special lines.
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^```/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^(\s*)[-*+]\s+/.test(lines[i]) &&
      !/^(\s*)\d+\.\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s{0,3}([-*_])\s*\1\s*\1\s*$/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    html.push(
      `<p class="my-2 leading-relaxed">${renderInline(escapeHtml(para.join(" ")))}</p>`,
    );
  }

  return html.join("\n");
}

function renderNestedList(
  items: { indent: number; html: string }[],
  tag: "ul" | "ol" = "ul",
): string {
  if (!items.length) return "";
  const cls = tag === "ul" ? "my-2 list-disc pl-6" : "my-2 list-decimal pl-6";
  const itemCls = "my-0.5 leading-relaxed";

  // Flatten: if indents don't change, single-level list.
  const first = items[0].indent;
  const flat = items.every((it) => it.indent === first);
  if (flat) {
    return `<${tag} class="${cls}">${items
      .map((it) => `<li class="${itemCls}">${it.html}</li>`)
      .join("")}</${tag}>`;
  }

  // Multi-level: build a tree.
  type Node = { html: string; children: Node[] };
  const rootChildren: Node[] = [];
  const stack: { indent: number; node: Node }[] = [];

  for (const it of items) {
    const node: Node = { html: it.html, children: [] };
    while (stack.length && stack[stack.length - 1].indent >= it.indent) stack.pop();
    if (stack.length === 0) {
      rootChildren.push(node);
    } else {
      stack[stack.length - 1].node.children.push(node);
    }
    stack.push({ indent: it.indent, node });
  }

  const renderNode = (n: Node): string =>
    `<li class="${itemCls}">${n.html}${
      n.children.length
        ? `\n<${tag} class="my-1 ${tag === "ul" ? "list-disc" : "list-decimal"} pl-6">${n.children
            .map(renderNode)
            .join("")}</${tag}>`
        : ""
    }</li>`;

  return `<${tag} class="${cls}">${rootChildren.map(renderNode).join("")}</${tag}>`;
}