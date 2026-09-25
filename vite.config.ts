import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "node:path";

// Tauri expects a fixed port; fail if it's not available.
const host = process.env.TAURI_DEV_HOST;

// The script-template builder embeds `import http from "k6/http"`
// inside template literals — esbuild sees the `import` keyword and
// tries to resolve the bare specifier, breaking both dev and build.
// Tell Vite to stub both modules with empty exports so esbuild is
// happy; nothing actually executes the import at runtime (k6 scripts
// are written by the user, not by the app).
const k6StubPlugin = {
  name: "perf-pilot-k6-stub",
  enforce: "pre" as const,
  resolveId(id: string) {
    if (id === "k6/http" || id === "k6") return "\0k6-stub";
  },
  load(id: string) {
    if (id === "\0k6-stub") return "export default {}; export const __k6Stub = true;";
  },
};

// https://vite.dev/config/
export default defineConfig({
  plugins: [k6StubPlugin, vue()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2021",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
  optimizeDeps: {
    include: ["monaco-editor"],
  },
});