// Regression guard for TUI startup latency. The TUI's shell builds the Dashboard tab EAGERLY (only
// Config/Doctor are dynamically imported and lazy), so anything the Dashboard graph pulls in lands on
// the critical startup path. Twice now a convenience import has dragged the engine's Effect +
// OpenTelemetry stack (~2s of cold module load) into that path — most recently via
// `dashboard.ts → watchers/updater.ts → telemetry/index.ts`, for a single pure status read.
//
// This test walks the EAGER import graph from the TUI entry — static `import`/`export … from` edges
// only, so it naturally stops at the `await import(...)` boundaries that lazy-load the heavy tabs —
// and asserts none of the heavy modules reappear. If it fails, read the printed import chain: it
// names the exact edge that reintroduced the weight. The fix is a lazy `import()` at the tab boundary
// or, for a pure helper, a telemetry-free module (see watchers/update-status.ts) — not loosening this.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = resolve(fileURLToPath(new URL("../src", import.meta.url)));
const ENTRY = resolve(SRC, "tui/index.ts");

/** Strip comments so an import-looking string inside a comment can't register as an edge. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Static module specifiers referenced by `code`: `import … from "x"`, `export … from "x"`, and
 *  side-effect `import "x"`. Dynamic `import("x")` is deliberately EXCLUDED — that's the lazy edge. */
function staticSpecifiers(code: string): string[] {
  const src = stripComments(code);
  const specs: string[] = [];
  // `import … from "x"` / `export … from "x"` (may span lines; the `from` disambiguates from dynamic import()).
  for (const m of src.matchAll(/\b(?:import|export)\b[\s\S]*?\bfrom\s*["']([^"']+)["']/g)) specs.push(m[1]!);
  // Side-effect `import "x"` — the required whitespace before the quote never matches `import(`.
  for (const m of src.matchAll(/\bimport\s+["']([^"']+)["']/g)) specs.push(m[1]!);
  return specs;
}

/** BFS the eager graph from ENTRY, following relative (.ts) edges. Returns every reached local file
 *  and package, each with the shortest import chain that pulled it in (for a legible failure). */
function eagerGraph(): { locals: Map<string, string[]>; packages: Map<string, string[]> } {
  const locals = new Map<string, string[]>(); // abs .ts path -> chain of relative paths from entry
  const packages = new Map<string, string[]>(); // bare specifier -> chain that first reached it
  const rel = (abs: string) => abs.slice(SRC.length + 1);
  const queue: { file: string; chain: string[] }[] = [{ file: ENTRY, chain: [rel(ENTRY)] }];
  locals.set(ENTRY, [rel(ENTRY)]);
  while (queue.length) {
    const { file, chain } = queue.shift()!;
    let code: string;
    try {
      code = readFileSync(file, "utf8");
    } catch {
      continue; // e.g. a native/.node dep referenced by path — nothing to parse
    }
    for (const spec of staticSpecifiers(code)) {
      if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec);
        if (locals.has(target)) continue;
        const nextChain = [...chain, rel(target)];
        locals.set(target, nextChain);
        queue.push({ file: target, chain: nextChain });
      } else if (!spec.startsWith("node:")) {
        const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
        if (!packages.has(pkg)) packages.set(pkg, [...chain, spec]);
      }
    }
  }
  return { locals, packages };
}

describe("TUI startup import graph", () => {
  const { locals, packages } = eagerGraph();

  // Heavy engine modules that must load ONLY behind a lazy tab boundary, never on the eager path.
  const forbiddenLocals = [
    "telemetry/index.ts", // Effect + OTel wiring
    "runtime/effect.ts", // the Effect runtime + OTel layer
    "watchers/updater.ts", // the update EXECUTOR (git/provision → telemetry); its readers live in update-status.ts
    "server/client.ts", // engine client — pulls Effect
    "config.ts", // 87k zod schema + registries; belongs to the (lazy) config tab
  ];
  // Heavy packages that must never be eager. The engine needs them; the TUI shell does not.
  const isForbiddenPackage = (p: string) =>
    p === "effect" || p.startsWith("@effect/") || p.startsWith("@opentelemetry/") || p.startsWith("@aws-sdk/");

  it("builds the eager graph (sanity: the entry and dashboard are reached)", () => {
    const reached = [...locals.keys()].map((f) => f.slice(SRC.length + 1));
    expect(reached).toContain("tui/index.ts");
    expect(reached).toContain("tui/dashboard.ts");
  });

  it.each(forbiddenLocals)("does not eagerly import %s", (target) => {
    const abs = resolve(SRC, target);
    const chain = locals.get(abs);
    expect(chain, chain && `eager chain: ${chain.join(" → ")}`).toBeUndefined();
  });

  it("does not eagerly import Effect / OpenTelemetry / AWS SDK", () => {
    const offenders = [...packages.entries()]
      .filter(([p]) => isForbiddenPackage(p))
      .map(([p, chain]) => `${p} via ${chain.join(" → ")}`);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
