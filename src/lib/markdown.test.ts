import { describe, it, expect } from "vitest";
import { renderMarkdown } from "@/lib/markdown";

describe("renderMarkdown", () => {
  it("renders an empty input as an empty string", () => {
    expect(renderMarkdown("")).toBe("");
  });

  it("renders paragraphs", () => {
    expect(renderMarkdown("Hello world")).toContain("<p");
    expect(renderMarkdown("Hello world")).toContain("Hello world");
  });

  it("renders H1-H6 headings", () => {
    const md = "# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6";
    const html = renderMarkdown(md);
    expect(html).toMatch(/<h1[^>]*>H1<\/h1>/);
    expect(html).toMatch(/<h2[^>]*>H2<\/h2>/);
    expect(html).toMatch(/<h3[^>]*>H3<\/h3>/);
    expect(html).toMatch(/<h4[^>]*>H4<\/h4>/);
    expect(html).toMatch(/<h5[^>]*>H5<\/h5>/);
    expect(html).toMatch(/<h6[^>]*>H6<\/h6>/);
  });

  it("renders fenced code blocks", () => {
    const md = "```javascript\nconst x = 1;\n```";
    const html = renderMarkdown(md);
    expect(html).toMatch(/<pre[^>]*><code>/);
    expect(html).toContain("const x = 1;");
    expect(html).toContain("data-lang=\"javascript\"");
  });

  it("renders fenced code blocks without language", () => {
    const md = "```\nplain\n```";
    const html = renderMarkdown(md);
    expect(html).toContain("plain");
    expect(html).not.toContain("data-lang=");
  });

  it("escapes HTML in code blocks", () => {
    const md = "```\n<script>alert(1)</script>\n```";
    const html = renderMarkdown(md);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders inline code with surrounding text", () => {
    const md = "Use `k6 run` to start";
    const html = renderMarkdown(md);
    expect(html).toContain("<code");
    expect(html).toContain("k6 run");
  });

  it("renders bold and italic", () => {
    const md = "**bold** and *italic* and __also bold__ and _also italic_";
    const html = renderMarkdown(md);
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<strong>also bold</strong>");
    expect(html).toContain("<em>also italic</em>");
  });

  it("renders links and only allows safe schemes", () => {
    expect(renderMarkdown("[ok](https://example.com)")).toContain('href="https://example.com"');
    expect(renderMarkdown("[ok](mailto:a@b.com)")).toContain('href="mailto:a@b.com"');
    expect(renderMarkdown("[blocked](javascript:alert(1))")).toContain('href="#"');
  });

  it("renders unordered lists", () => {
    const md = "- one\n- two\n- three";
    const html = renderMarkdown(md);
    expect(html).toContain("<ul");
    expect(html).toMatch(/<li[^>]*>one<\/li>/);
    expect(html).toMatch(/<li[^>]*>two<\/li>/);
  });

  it("renders ordered lists", () => {
    const md = "1. first\n2. second\n3. third";
    const html = renderMarkdown(md);
    expect(html).toContain("<ol");
    expect(html).toMatch(/<li[^>]*>first<\/li>/);
    expect(html).toMatch(/<li[^>]*>third<\/li>/);
  });

  it("renders nested unordered lists", () => {
    const md = "- parent\n  - child\n  - child2\n- sibling";
    const html = renderMarkdown(md);
    expect(html).toContain("<ul");
    // Inner list should appear inside the first <li>.
    expect(html).toMatch(/<li[^>]*>parent[\s\S]*<ul/);
  });

  it("renders blockquotes", () => {
    const md = "> quoted text";
    const html = renderMarkdown(md);
    expect(html).toContain("<blockquote");
    expect(html).toContain("quoted text");
  });

  it("renders horizontal rules", () => {
    expect(renderMarkdown("---")).toContain("<hr");
    expect(renderMarkdown("***")).toContain("<hr");
    expect(renderMarkdown("___")).toContain("<hr");
  });

  it("renders GFM tables", () => {
    const md = "| name | value |\n| --- | --- |\n| foo | 1 |\n| bar | 2 |";
    const html = renderMarkdown(md);
    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect(html).toContain("<td");
    expect(html).toContain("foo");
    expect(html).toContain("1");
  });

  it("escapes HTML special characters in inline content", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes ampersands", () => {
    const html = renderMarkdown("A & B");
    expect(html).toContain("A &amp; B");
  });

  it("renders a complete report-shaped document", () => {
    const md = `# Performance Report

## Executive Summary

Things look good. **p95** is under *250ms*.

## Key Metrics

| Metric | Value |
| --- | --- |
| req count | 532 |
| p95 | 210ms |

## Recommendations

1. Cache the \`/api/health\` response.
2. Add a check on /users/:id.

\`\`\`javascript
http.get('https://api.example.com/health')
\`\`\`
`;
    const html = renderMarkdown(md);
    expect(html).toMatch(/<h1[^>]*>Performance Report<\/h1>/);
    expect(html).toContain("<table");
    expect(html).toContain("<strong>p95</strong>");
    expect(html).toContain("<em>250ms</em>");
    expect(html).toContain("<ol");
    expect(html).toMatch(/<li[^>]*>Cache the <code/);
    expect(html).toContain("http.get");
  });
});