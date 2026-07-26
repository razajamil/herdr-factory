// Tier 2: a REAL model driving a real belt, through the SHIPPED prompts.
//
// The scripted tier proves the machinery; it cannot prove the prompts. A prompt that a determined
// shim follows perfectly can still be ambiguous to a model — and the prompts are the part of this
// system that a human never reviews at runtime. So this tier runs `opencode` against a LOCAL model
// (no per-run cost, no rate limit, no data leaving the machine) and asks one question: following only
// what the factory told it, does the model get the work to a pull request?
//
// It is deliberately non-gating. A model is not deterministic, and a red build that means "the model
// had an off day" trains people to ignore red builds. Scenarios tagged `tier: "ds4"` are SKIPPED
// unless the tier is explicitly selected, and what they produce is a transcript and a wall clock.
//
// Provider details mirror the operator's own opencode config (`~/.config/opencode/opencode.jsonc`):
// an openai-compatible endpoint on :8000 serving `deepseek-v4-flash`.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DS4_PROVIDER = "ds4";
export const DS4_MODEL = "deepseek-v4-flash";
/** What `-m` takes, and what a scenario's `agent.flags` should name. */
export const DS4_MODEL_REF = `${DS4_PROVIDER}/${DS4_MODEL}`;

/** The endpoint as seen from wherever the suite is running. A container reaches the host's model
 *  server through `host.docker.internal`; on the host it is plain loopback. */
export function ds4BaseUrl(): string {
  const explicit = process.env.HF_DS4_BASE_URL?.trim();
  if (explicit) return explicit;
  const host = existsSync("/.dockerenv") ? "host.docker.internal" : "127.0.0.1";
  return `http://${host}:8000/v1`;
}

export function ds4ApiKey(): string {
  return process.env.HF_DS4_API_KEY?.trim() || "dsv4-local";
}

/** The real `opencode`, resolved absolutely — the world's wrapper execs this, so a bare name here
 *  would re-resolve to the wrapper and exec-loop (the same trap the herdr wrapper has). */
export function resolveOpencode(): string {
  const explicit = process.env.HF_OPENCODE_REAL?.trim();
  if (explicit) return explicit;
  const r = spawnSync("bash", ["-lc", "command -v opencode"], { encoding: "utf8" });
  const found = (r.stdout ?? "").trim().split("\n").filter(Boolean).pop();
  if (!found) {
    throw new Error(
      "the ds4 tier needs the `opencode` CLI on PATH (set HF_OPENCODE_REAL to point at it). " +
        "It is not in the e2e image — this tier runs on the host against the local model server.",
    );
  }
  return found;
}

/** Fail BEFORE a scenario starts if the model server isn't answering: otherwise the agent boots, the
 *  model call fails inside the pane, and the whole thing surfaces minutes later as a step that never
 *  signalled — indistinguishable from a prompt the model couldn't follow, which is the one thing this
 *  tier exists to measure. */
export function ds4Preflight(): { baseUrl: string; models: string[] } {
  const baseUrl = ds4BaseUrl();
  const r = spawnSync("curl", ["-fsS", "-m", "10", "-H", `Authorization: Bearer ${ds4ApiKey()}`, `${baseUrl}/models`], { encoding: "utf8" });
  if ((r.status ?? -1) !== 0) {
    throw new Error(
      `the ds4 tier's model server is not answering at ${baseUrl} (${(r.stderr || "").trim() || `curl exit ${r.status}`}). ` +
        `Start the local server, or point HF_DS4_BASE_URL somewhere that serves an OpenAI-compatible /models.`,
    );
  }
  let models: string[] = [];
  try {
    const body = JSON.parse(r.stdout) as { data?: { id?: string }[] };
    models = (body.data ?? []).map((m) => m.id ?? "").filter(Boolean);
  } catch {
    models = [];
  }
  if (models.length > 0 && !models.some((m) => m === DS4_MODEL || m.endsWith(`/${DS4_MODEL}`))) {
    throw new Error(`the ds4 tier expects the model "${DS4_MODEL}" at ${baseUrl}; it serves: ${models.join(", ")}`);
  }
  return { baseUrl, models };
}

/** Write the world's own opencode config (HOME is the world, so this is the config opencode loads).
 *  Only the provider and the default model — everything else is left at opencode's defaults, because
 *  the point is to run the model the way an operator would, not a tuned harness variant. */
export function writeOpencodeConfig(home: string): string {
  const dir = join(home, ".config", "opencode");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "opencode.json");
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        model: DS4_MODEL_REF,
        small_model: DS4_MODEL_REF,
        provider: {
          [DS4_PROVIDER]: {
            name: "ds4 (local, e2e)",
            npm: "@ai-sdk/openai-compatible",
            options: {
              baseURL: ds4BaseUrl(),
              apiKey: ds4ApiKey(),
              // A local model on a busy machine is slow, not broken; the factory's own step budget is
              // what should decide when an agent has taken too long.
              timeout: false,
              headerTimeout: false,
              chunkTimeout: 1_800_000,
            },
            models: { [DS4_MODEL]: { name: DS4_MODEL, reasoning: true, tool_call: true } },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

/** opencode resolves its provider package (`@ai-sdk/openai-compatible`) into its own data dir, and the
 *  world's HOME is fresh — so the first ds4 run installs it, which needs network and a few seconds. Set
 *  `HF_OPENCODE_DATA_HOME` to a warm directory (e.g. `$HOME/.local/share`) to reuse an existing install;
 *  that is the tier's one deliberate hole in the world's hermeticity, and it is opt-in. */
export function ds4DataHome(home: string): string {
  return process.env.HF_OPENCODE_DATA_HOME?.trim() || join(home, ".local", "share");
}

/** The flags a ds4 scenario's `agent:` block should carry. `--auto` is the autonomy the factory
 *  assumes (an agent that stops to ask for approval is an agent that never signals), and `--pure`
 *  keeps the operator's own opencode plugins out of a hermetic run. */
export function ds4AgentFlags(): string[] {
  return ["--auto", "--pure", "-m", DS4_MODEL_REF];
}
