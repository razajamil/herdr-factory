// Vitest config for the end-to-end suite. Deliberately separate from the root vitest.config.ts:
// `npm test` must stay a fast unit run, and these scenarios each boot a real herdr server, a
// resident factory `serve` and real PTY panes.
//
// Only reached through scripts/e2e (which runs it inside docker/Dockerfile.e2e) — `serve` binds
// 127.0.0.1, so the assertions have to live in the same network namespace as the server.
//
// Scenario files are `*.e2e.ts`, which the root config's default include
// (`**/*.{test,spec}.?(c|m)[jt]s?(x)`) does not match — that is what keeps `npm test` clean.
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const ROOT = resolve(import.meta.dirname, "../..");

// scripts/e2e mounts the host artifacts dir here. The local default keeps a bare
// `vitest run --config test/e2e/vitest.e2e.config.ts` (e.g. from `scripts/e2e --shell`) writable.
const artifacts = process.env.HF_E2E_ARTIFACTS ?? resolve(ROOT, "artifacts/e2e/local");

export default defineConfig({
  root: ROOT,
  test: {
    include: ["test/e2e/scenarios/**/*.e2e.ts"],

    // A scenario is a whole belt run against real processes: minutes, not milliseconds.
    testTimeout: 300_000,
    // World construction (git repo + bare origin + herdr server + `serve` boot) owns the hooks.
    hookTimeout: 120_000,
    teardownTimeout: 60_000,

    // Strictly sequential for now. Every world spawns a herdr server, a factory server and real
    // PTYs; running two at once fights over CPU and makes the compressed clocks
    // (tick_interval_seconds: 1, budget_seconds: 5) flaky. Parallelism comes after the suite is
    // trustworthy. `fileParallelism: false` pins it to one file at a time and forces maxWorkers to
    // 1; `maxConcurrency: 1` stops concurrent tests inside a file.
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
    maxConcurrency: 1,
    // Keep the default per-file isolation: the harness mutates process.env (HOME, PATH,
    // HERDR_SOCKET_PATH) to point at its world, and leaking that across scenarios would be silent
    // cross-contamination.
    isolate: true,

    reporters: [
      "default",
      ["junit", { outputFile: resolve(artifacts, "junit.xml"), suiteName: "herdr-factory e2e" }],
      ["json", { outputFile: resolve(artifacts, "results.json") }],
    ],
  },
});
