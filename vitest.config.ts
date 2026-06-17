import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // better-sqlite3 is a native addon — load it via Node's require, not Vite's
    // SSR transform (which breaks the `bindings` .node resolution).
    server: { deps: { external: ["better-sqlite3"] } },
  },
});
