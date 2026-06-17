#!/usr/bin/env -S node --import tsx
// Thin launcher: run the TypeScript CLI through tsx (no build step).
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

await import(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts"));
