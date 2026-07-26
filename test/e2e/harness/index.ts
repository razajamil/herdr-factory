// The scenario entry point. A scenario file is: `scenario(spec, async (w) => { … })`.
//
// Lifecycle per scenario: build a fresh world → start herdr + the factory → run the body → stop
// everything → collect artifacts (always, pass or fail). Any failure gets the world's diagnosis
// (run state, timeline, engine log, agent transcript) appended, because a bare `expected true` from
// a black-box system is useless.
import { describe, test } from "vitest";
import { World } from "./world.ts";
import type { Lane, ScenarioSpec } from "./types.ts";

export { World } from "./world.ts";
export * from "./assert.ts";
export type { AgentBehaviour, AgentScript, Driver, Lane, ScenarioSpec, Tier, WorldPaths } from "./types.ts";

// The suite runs the REAL engine, which needs Node >= 26 for native type-stripping — and the agents
// inherit the harness's own node through the world's shim. Refuse up front: under 24 everything starts
// normally and then every `step-done` fails inside a pane with a version error, which surfaces two
// minutes later as an inscrutable "awaiting step-done" timeout.
const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
if (NODE_MAJOR < 26) {
  throw new Error(
    `the e2e harness needs Node >= 26 (running ${process.version}). The repo pins 26.4.0 in .node-version — ` +
      `activate it (mise/fnm/nvm) before \`npm run test:e2e\`, or run the suite in its container via \`scripts/e2e\`.`,
  );
}

function selected(spec: ScenarioSpec): { run: boolean; why: string } {
  const wantLane = process.env.HF_E2E_LANE?.trim() as Lane | undefined;
  const lane = spec.lane ?? "real";
  if (wantLane && wantLane !== lane) return { run: false, why: `lane=${lane} (filtered to ${wantLane})` };
  if (spec.slow && process.env.HF_E2E_SLOW !== "1") return { run: false, why: "slow (set HF_E2E_SLOW=1)" };
  if (spec.tier === "ds4" && (process.env.HF_E2E_TIER ?? "scripted") !== "ds4") return { run: false, why: "tier=ds4 (set --tier ds4)" };
  return { run: true, why: "" };
}

export function scenario(spec: ScenarioSpec, body: (w: World) => Promise<void>): void {
  const sel = selected(spec);
  describe(spec.name, () => {
    const title = `${spec.name} [lane=${spec.lane ?? "real"} tier=${spec.tier ?? "scripted"}]`;
    if (!sel.run) {
      test.skip(`${title} — skipped: ${sel.why}`, () => undefined);
      return;
    }
    test(
      title,
      async () => {
        const w = new World(spec);
        let failure: unknown = null;
        try {
          await w.start();
          await body(w);
        } catch (e) {
          failure = e;
          if (e instanceof Error && !e.message.includes("— DB state —")) {
            e.message = `${e.message}\n\n${w.diagnose("scenario failed")}`;
          }
        } finally {
          await w.stop().catch(() => undefined);
          w.collect();
        }
        if (failure) throw failure;
      },
      spec.timeoutMs ?? 180_000,
    );
  });
}
