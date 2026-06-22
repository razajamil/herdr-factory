import { defineConfig } from "vitest/config";

// SQLite is now Node's built-in `node:sqlite` (no native addon), so no externalization is needed —
// vitest treats `node:*` builtins as external automatically.
export default defineConfig({});
