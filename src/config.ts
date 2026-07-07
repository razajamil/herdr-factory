import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { SourceType } from "./types.ts";
import { expandHome } from "./paths.ts";
import { SOURCE_DESCRIPTORS, descriptorFor } from "./sources/registry.ts";

// ── Work sources: where to poll work from (no agents/pipeline here anymore — that's a belt). ──
// Each type's block schema + resolution lives on its descriptor (src/sources/<type>/descriptor.ts);
// this file only joins them into the discriminated union and drives the generic resolve loop.

// ── Evidence upload: where the `evidence` step publishes captured screenshots/video (S3 + CloudFront).
// Non-secret infra pointers ONLY — AWS credentials come from the ambient AWS credential chain (~/.aws /
// AWS_* env / SSO / the named `profile`), never stored in config or handed to an agent. Optional: a repo
// that omits it still gets an evidence step (capture + assess + bounce), it just publishes nothing.
const EvidenceBlockSchema = z
  .object({
    bucket: z.string().trim().min(1),
    region: z.string().trim().min(1),
    // Accept a bare host or a full URL; normalize to a bare host used to build https:// asset URLs.
    cloudfront_domain: z
      .string()
      .trim()
      .min(1)
      .transform((s) => s.replace(/^https?:\/\//, "").replace(/\/+$/, "")),
    // Optional S3 key prefix (leading/trailing slashes trimmed); evidence lands under
    // <key_prefix>/<work_key>/<run>-<timestamp>/<file>.
    key_prefix: z
      .string()
      .trim()
      .default("")
      .transform((s) => s.replace(/^\/+|\/+$/g, "")),
    // Optional AWS CLI named profile (else the default credential chain).
    profile: z.string().trim().min(1).optional(),
    // Optional override for the per-user evidence folder. Evidence lands under
    // `herdr-factory/<github_username>/<key_prefix>/…`; when unset, <github_username> is derived from
    // the gh CLI's authenticated login at upload time.
    github_username: z.string().trim().min(1).optional(),
  })
  .strict();

/** The S3 key prefix for one evidence capture:
 *  `herdr-factory / <github_username> / <key_prefix> / <ticketKey> / <runId>-<timestamp>`.
 *  Empty segments (unset username or key_prefix) are dropped, so the base is always `herdr-factory/`. */
export function evidenceKeyPrefix(opts: {
  githubUsername?: string;
  keyPrefix?: string;
  ticketKey: string;
  runId: number | string;
  stamp: string;
}): string {
  return ["herdr-factory", opts.githubUsername, opts.keyPrefix, opts.ticketKey, `${opts.runId}-${opts.stamp}`]
    .filter(Boolean)
    .join("/");
}

// A work source is just identity + a type-specific backend block. The OPTIONAL `name` (default =
// type, unique within the repo) is what a belt's `source:` references and what each run records on
// its `work_source` column.
// `.strict()` on the union members (each descriptor's configSchema): an unknown key (a typo, or
// the wrong type's block) is rejected at parse time with a clear "Unrecognized key" rather than
// being silently dropped. The union is assembled from the registry so a new source type never
// edits this file.
/** The minimal shape every parsed source object shares; the type-specific block rides along as
 *  unknown keys and is interpreted by its descriptor's resolveConfig. */
interface ParsedWorkSource {
  type: SourceType;
  name?: string;
  [key: string]: unknown;
}
const WorkSourceSchema = z.discriminatedUnion(
  "type",
  SOURCE_DESCRIPTORS.map((d) => d.configSchema) as unknown as Parameters<typeof z.discriminatedUnion>[1],
) as unknown as z.ZodType<ParsedWorkSource>;

// ── Belts: a (source + ordered steps) pairing. The belt is the unit of work flow. ──

// A step's herdr layout target. OPTIONAL, both-or-neither: when tab+pane are set the dispatcher
// waits for the user's layout to bring that pane up (with an idle agent) and delivers the prompt
// there — it never spawns its own. When omitted, it spawns a dedicated pane itself.
const layoutFields = { tab: z.string().optional(), pane: z.string().optional() };
const bothOrNeither = (a: { tab?: string; pane?: string }) => (a.tab == null) === (a.pane == null);
const layoutRefine = {
  message: "tab and pane must be set together (or both omitted to spawn a dedicated pane)",
  path: ["pane"] as string[],
};

// Where a `prompt_file` is resolved from: `config` = relative to this repo's config folder
// (repos/<name>/); `repo` = relative to the target repo checkout, read from the run's WORKTREE at
// render time (so the prompt can live version-controlled in the codebase).
const PromptSourceSchema = z.enum(["repo", "config"]);
const promptFileFields = { prompt_file: z.string().optional(), prompt_file_source: PromptSourceSchema.optional() };
const promptSourceRefine = [
  (a: { prompt_file?: string; prompt_file_source?: "repo" | "config" }) => !a.prompt_file || a.prompt_file_source != null,
  { message: "prompt_file_source is required when prompt_file is set", path: ["prompt_file_source"] as string[] },
] as const;

// work_to_pull_request belts have engine-defined steps (fix → evidence → review → pr) whose prompts
// the engine ships; an agent block picks the layout pane and may OPTIONALLY add a `prompt_file`
// (with a required `prompt_file_source`) that AUGMENTS the engine prompt for that step. fix/review/pr
// are required; `evidence` is OPTIONAL (backward-compatible with pre-evidence configs — when omitted
// the evidence step just spawns its own dedicated pane).
const PrAgentSchema = z
  .object({ ...layoutFields, ...promptFileFields })
  .strict()
  .refine(bothOrNeither, layoutRefine)
  .refine(...promptSourceRefine);
const PrAgentsSchema = z
  .object({ fix: PrAgentSchema, evidence: PrAgentSchema.optional(), review: PrAgentSchema, pr: PrAgentSchema })
  .strict();

// Step names are used in file paths (prompt-<name>.md / handoff-<name>.md), pane labels, and the
// step-done CLI arg — so keep them to a git/path-safe lowercase slug.
const StepNameSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "step name must be a lowercase slug ([a-z0-9_-], starting alphanumeric)");

// A custom belt's user-defined step. `prompt_file` (required) is the WHOLE step body — the engine
// adds only the handover scaffold — and `prompt_file_source` (required) says where to read it from.
// Optional per-step budget + commit-stall heartbeat (off by default: research/proposal-style steps
// legitimately make no commits).
const CustomStepSchema = z
  .object({
    name: StepNameSchema,
    prompt_file: z.string(),
    prompt_file_source: PromptSourceSchema,
    budget_seconds: z.coerce.number().int().positive().optional(),
    heartbeat: z.boolean().default(false),
    ...layoutFields,
  })
  .strict()
  .refine(bothOrNeither, layoutRefine);

// A per-belt branch-name template (the worktree + workspace derive from it). Must include
// {{work_id}} so the branch is identifiable by ticket; a short unique suffix is appended
// automatically (see branchName) so each claim — including a RE-claim of a previously-merged
// ticket — gets a distinct branch. Vars: {{work_id}} {{work_slug}} (<=20) {{work_full_slug}}
// (<=50) {{work_type}} {{semantic_work_prefix}} (fix|chore|feature).
const WorkspaceNameSchema = z
  .string()
  .refine((s) => /\{\{\s*work_id\s*\}\}/.test(s), {
    message: "workspace_name must include {{work_id}} so each item gets a unique branch",
  })
  .optional();

// Fields every belt shares. `source` references a work_source by name (validated below). `match`
// is an OPTIONAL path to a `.ts` module (default export = predicate); when omitted the belt
// accepts anything from its source. Lower `priority` = matched first (first matching belt claims).
const beltBase = {
  name: z.string().trim().min(1),
  source: z.string().trim().min(1),
  priority: z.coerce.number().int().default(100),
  workspace_name: WorkspaceNameSchema,
  match: z.string().optional(),
  // The label this belt picks up work by — the tag on a source item that flags it for this belt.
  // NO DEFAULT (deliberate: you name the label explicitly). REQUIRED for a belt whose source picks
  // up by label (jira, github_issues), FORBIDDEN for one whose source has no label concept
  // (local_markdown) — both enforced in superRefine, which knows each belt's source type. It's
  // threaded into the source's listEligible/transition/health, so it filters SERVER-SIDE (jira JQL,
  // GitHub's label query), not after the fact. Two belts may share a source only via DISTINCT
  // labels — the same (source, label) in two belts is contention (also rejected below).
  label: z.string().trim().min(1).optional(),
  // Optional per-belt override of the repo-wide max_bounces safety cap (the loop-safety backstop for
  // the fix↔evidence/review rework loop). Unset ⇒ falls back to limits.max_bounces.
  max_bounces: z.coerce.number().int().nonnegative().optional(),
};

// `.strict()` so a w2pr belt can't carry `steps`, a custom belt can't carry `agents`, and typos in
// any belt field are rejected at parse time (the discriminated union routes on belt_type; strict
// enforces that only that variant's fields are present).
const WorkToPrBeltSchema = z
  .object({ belt_type: z.literal("work_to_pull_request"), ...beltBase, agents: PrAgentsSchema })
  .strict();
const CustomBeltSchema = z
  .object({
    belt_type: z.literal("custom"),
    ...beltBase,
    steps: z.array(CustomStepSchema).min(1, "a custom belt needs at least one step"),
  })
  .strict();
const BeltSchema = z.discriminatedUnion("belt_type", [WorkToPrBeltSchema, CustomBeltSchema]);

export const RepoConfigSchema = z
  .object({
    repo: z.object({
      path: z.string(),
      base_ref: z.string().default("origin/main"),
      github: z.string().optional(),
    }),
    limits: z
      .object({
        // Cap on concurrently WORKED workspaces (one worktree per run). A slot is held by a run
        // being actively worked — claiming/running/tearing_down, and a `reviewing` run ONLY while
        // its resolver is actively addressing review comments. Runs that keep their worktree but do
        // no work hold no slot: the parks (attention, waiting_for_human) and an idle PR-watch. So
        // neither human-blocked runs nor long-lived PRs-in-review starve the belt of new claims.
        // NOT a cap on total worktrees on disk (parked/watching runs add to that) nor on agents (a
        // run spawns one pane per step). The PR watch has no time limit — see reviewing occupancy.
        max_active_workspaces: z.coerce.number().int().positive().default(3),
        // Re-notify the operator about a run parked in `attention` every this-many seconds (the
        // escalation notify is easy to miss; a parked run should never go silently stale).
        attention_renotify_seconds: z.coerce.number().int().positive().default(3600),
        develop_budget_seconds: z.coerce.number().int().positive().default(5400),
        stall_seconds: z.coerce.number().int().positive().default(2700),
        review_budget_seconds: z.coerce.number().int().positive().default(1800),
        // The evidence step captures + (optionally) records video and uploads — generous by default.
        evidence_budget_seconds: z.coerce.number().int().positive().default(2400),
        pr_budget_seconds: z.coerce.number().int().positive().default(3600),
        // SAFETY BACKSTOP for the fix↔evidence/review rework loop — not the intended terminator. The
        // loop is meant to end when evidence/review pass (aligned) or the fix agent asks a human; this
        // cap only catches genuine oscillation. Max times a run may bounce back to any ONE earlier step
        // before escalating to attention. 0 disables bouncing (first bounce escalates). Per-belt
        // `max_bounces` overrides this.
        max_bounces: z.coerce.number().int().nonnegative().default(6),
        // SAFETY BACKSTOP for the evidence step's capture loop — not the intended terminator. The
        // evidence prompt's cooperative guidance is "re-record a flaky take, then ask a human"; this
        // cap catches an agent stuck re-capturing a nondeterministic app. Max capture attempts the
        // evidence agent may SIGNAL (via `capture-attempt`) in one pass before escalating to
        // attention. Reset per fresh pass into the step (unlike max_bounces, which is cumulative). 0
        // parks on the first attempt (effectively disables capture) — leave the default unless you
        // mean that.
        max_capture_attempts: z.coerce.number().int().nonnegative().default(5),
        // Default budget for a custom belt's step when it sets no `budget_seconds` of its own.
        step_budget_seconds: z.coerce.number().int().positive().default(3600),
        tick_interval_seconds: z.coerce.number().int().positive().default(60),
        // How many active runs Phase A reconciles concurrently. Most of a run's reconcile is
        // subprocess/network wait, so parallelism keeps tick wall-clock roughly flat as the
        // active-run count grows; each run still holds its own run lock.
        reconcile_concurrency: z.coerce.number().int().positive().default(8),
        // Max NEW claims per tick (each claim ≈ worktree checkout + materialize + ~5 source
        // calls). Smooths a big-backlog cold start over successive ticks instead of one
        // source-hammering mega-tick; remaining slots fill on the next passes.
        max_claims_per_tick: z.coerce.number().int().positive().default(10),
        // How long to wait for a step's configured tab/pane to come up (with an idle agent)
        // before flagging the item for attention. Generous by default to allow the user's
        // layout setup + dev-server startup to finish; only applies to steps with a tab/pane.
        layout_wait_seconds: z.coerce.number().int().positive().default(600),
      })
      .prefault({}),
    // Backends this repo can pull work from (≥1). Each just names a type + its backend block;
    // the pipeline/agents live on a belt now.
    work_sources: z.array(WorkSourceSchema).min(1, "work_sources must list at least one source"),
    // Belts (≥1): each pairs a source with an ordered pipeline. At claim time belts are walked in
    // priority order and the first whose `match` accepts an item claims it (first match wins).
    belt: z.array(BeltSchema).min(1, "belt must list at least one belt"),
    // Optional: where the evidence step publishes captured media (S3 + CloudFront). Repo-wide.
    evidence: EvidenceBlockSchema.optional(),
  })
  .superRefine((cfg, ctx) => {
    // Work source names unique on the RESOLVED name (name ?? type), so two unnamed jira sources
    // correctly collide on "jira" rather than both passing as undefined. Keep the name→type map so
    // the belt loop below can look up each source's descriptor (label-driven or not).
    const sourceNames = new Set<string>();
    const sourceTypeByName = new Map<string, SourceType>();
    cfg.work_sources.forEach((s, i) => {
      const name = s.name ?? s.type;
      if (sourceNames.has(name)) {
        ctx.addIssue({ code: "custom", message: `duplicate work source name "${name}" — give each source a unique name`, path: ["work_sources", i, "name"] });
      }
      sourceNames.add(name);
      sourceTypeByName.set(name, s.type);
    });
    // Belt names unique; each belt.source references a configured work source; custom step names
    // unique within their belt; the per-belt pickup `label` matches its source's label semantics
    // and is unique per (source, label).
    const beltNames = new Set<string>();
    const sourceLabelPairs = new Map<string, string>(); // "source\0label" -> first belt using it
    cfg.belt.forEach((b, i) => {
      if (beltNames.has(b.name)) {
        ctx.addIssue({ code: "custom", message: `duplicate belt name "${b.name}" — give each belt a unique name`, path: ["belt", i, "name"] });
      }
      beltNames.add(b.name);
      if (!sourceNames.has(b.source)) {
        ctx.addIssue({ code: "custom", message: `belt "${b.name}" references unknown work source "${b.source}" (configured: ${[...sourceNames].join(", ") || "none"})`, path: ["belt", i, "source"] });
      }
      // Per-belt pickup label: required exactly when the belt's source picks up by label. The
      // descriptor.pickupLabel manifest is the single source of truth for which types those are.
      const sourceType = sourceTypeByName.get(b.source);
      const pickup = sourceType ? descriptorFor(sourceType).pickupLabel : undefined;
      if (sourceType) {
        if (pickup && b.label == null) {
          ctx.addIssue({ code: "custom", message: `belt "${b.name}": source "${b.source}" (${sourceType}) picks up work by a ${pickup.noun} — set the belt's \`label\` (there is no default)`, path: ["belt", i, "label"] });
        } else if (!pickup && b.label != null) {
          ctx.addIssue({ code: "custom", message: `belt "${b.name}": source "${b.source}" (${sourceType}) has no label concept — remove \`label\``, path: ["belt", i, "label"] });
        }
      }
      // A belt is fed the items its source lists for (source, label); two belts on the SAME pair
      // would contend for the very same items (first-match-wins arbitrarily starves the other) —
      // split one source across belts with DISTINCT labels instead.
      if (b.label != null) {
        const key = `${b.source}\0${b.label}`;
        const first = sourceLabelPairs.get(key);
        if (first) {
          ctx.addIssue({ code: "custom", message: `belts "${first}" and "${b.name}" both pick up "${b.source}" work by label "${b.label}" — they'd contend for the same items; give each belt a distinct label`, path: ["belt", i, "label"] });
        } else {
          sourceLabelPairs.set(key, b.name);
        }
      }
      if (b.belt_type === "custom") {
        const stepNames = new Set<string>();
        b.steps.forEach((s, j) => {
          if (stepNames.has(s.name)) {
            ctx.addIssue({ code: "custom", message: `belt "${b.name}" has duplicate step name "${s.name}"`, path: ["belt", i, "steps", j, "name"] });
          }
          stepNames.add(s.name);
        });
      }
    });
  });

export type BeltType = "work_to_pull_request" | "custom";

/** One configured work source: identity + its resolved type-specific block. `cfg` is opaque to
 *  everything except the type's own descriptor (whose create() gets it back, typed). */
export interface WorkSourceConfig {
  name: string;
  type: SourceType;
  cfg: unknown;
}

/** One resolved belt step. The body the agent gets is assembled at RENDER time (step.ts): the
 *  `enginePrompt` base (work_to_pull_request steps only — undefined for custom) PLUS, if
 *  `promptFile` is set, the user prompt read from `promptFileSource` (`config` ⇒ the repo's config
 *  folder; `repo` ⇒ the run's worktree) — augmenting the engine base for w2pr, or being the whole
 *  body for custom. The engine then adds the handover scaffold + @@TOKEN@@ substitution. `opensPr`
 *  is true only for the work_to_pull_request `pr` step (the one that watches GitHub for a PR). */
export interface StepConfig {
  name: string;
  tab?: string;
  pane?: string;
  enginePrompt?: string; // shipped base body (w2pr); undefined for custom
  promptFile?: string; // user prompt path as written in config (optional for w2pr, required for custom)
  promptFileSource?: "config" | "repo"; // present iff promptFile is
  budgetSeconds: number;
  heartbeat: boolean; // commit-HEAD stall heartbeat applies to this step
  opensPr: boolean;
  gathersEvidence: boolean; // this step captures + publishes visual evidence (surfaces evidence guidance)
  canBounceTo: string[]; // earlier step names this step may send the run back to for rework (bounce)
}

/** One resolved belt: a (source + ordered steps) pairing with its lifecycle. `watchPr` true means
 *  the engine runs the token-free PR-watch (reviewing phase) after the last step. `matchFile` is
 *  the resolved path to the belt's `.ts` predicate (the predicate fn itself is loaded in buildDeps,
 *  which is async); undefined ⇒ the belt accepts anything from its source. */
export interface BeltConfig {
  name: string;
  beltType: BeltType;
  source: string; // work_source name
  priority: number;
  workspaceName?: string;
  matchFile?: string;
  /** The label this belt picks up work by, threaded into its source's listEligible/transition/
   *  health. Set for belts on a label-driven source (jira, github_issues); undefined for one whose
   *  source has no label concept (local_markdown). Enforced at parse time (see superRefine). */
  label?: string;
  steps: StepConfig[];
  watchPr: boolean;
  /** Per-belt override of the repo-wide bounce safety cap; undefined ⇒ use limits.maxBounces. */
  maxBounces?: number;
}

export interface Config {
  repoName: string;
  repo: { path: string; baseRef: string; github?: string };
  limits: {
    maxActiveWorkspaces: number;
    attentionRenotifySeconds: number;
    developBudgetSeconds: number;
    stallSeconds: number;
    reviewBudgetSeconds: number;
    evidenceBudgetSeconds: number;
    prBudgetSeconds: number;
    maxBounces: number;
    maxCaptureAttempts: number;
    stepBudgetSeconds: number;
    tickIntervalSeconds: number;
    reconcileConcurrency: number;
    maxClaimsPerTick: number;
    layoutWaitSeconds: number;
  };
  sources: WorkSourceConfig[];
  belts: BeltConfig[]; // sorted by priority asc (ties: config order)
  /** Where the evidence step publishes captured media (S3 + CloudFront). Undefined ⇒ no upload. */
  evidence?: {
    bucket: string;
    region: string;
    cloudfrontDomain: string;
    keyPrefix: string;
    githubUsername?: string;
    profile?: string;
  };
  guidance?: string;
  paths: {
    configDir: string;
    repoDir: string;
    stateRoot: string;
    stateDir: string;
    dbPath: string;
    logsDir: string;
  };
}

export interface Loaded {
  config: Config;
  /** The per-repo env file as a raw key/value map. Which keys matter is declared by each source
   *  descriptor's secrets manifest — the engine never interprets them. */
  env: Record<string, string>;
}

// `?.trim() ||` (not `??`): treat an empty/whitespace override as unset, so a stray
// `HERDR_FACTORY_STATE_ROOT=` doesn't collapse every state path to a relative "" root (and stays
// consistent with bin/herdr-factory's `${VAR:-default}`, which also falls back on empty).
function configDir(): string {
  return process.env.HERDR_FACTORY_CONFIG_DIR?.trim() || join(homedir(), ".config", "herdr-factory");
}
function stateRoot(): string {
  // resolve() so a relative HERDR_FACTORY_STATE_ROOT override becomes absolute (a no-op for the
  // absolute default): the vendored-runtime `current` symlink stores its target verbatim, and a
  // relative target would resolve against the LINK's own dir, not cwd — dangling it. The launchers
  // + service run from the package dir, so cwd is stable for the relative case anyway.
  return resolve(process.env.HERDR_FACTORY_STATE_ROOT?.trim() || join(homedir(), ".local", "state", "herdr-factory"));
}

// expandHome lives in the import-free leaf src/paths.ts (descriptors need it, and anything a
// descriptor imports must never lead back into this module — see paths.ts's header on the cycle).
export { expandHome };

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

/** herdr can't create worktrees from a linked worktree — require the MAIN checkout. */
export function assertMainCheckout(repoPath: string): void {
  const gitPath = join(repoPath, ".git");
  if (!existsSync(gitPath)) {
    throw new Error(`repo.path "${repoPath}" is not a git checkout (no .git)`);
  }
  if (!statSync(gitPath).isDirectory()) {
    throw new Error(
      `repo.path "${repoPath}" looks like a linked worktree (.git is a file); herdr needs the MAIN checkout`,
    );
  }
}

/** Path to the one global DB (repo-agnostic commands like capture-lock need it). */
export function globalDbPath(): string {
  return join(stateRoot(), "herdr-factory.db");
}

/** Machine-global file recording an absolute path to a verified Node >=24 binary. The CLI
 *  self-bakes `process.execPath` here on every run (it only ever runs under >=24); the
 *  `bin/herdr-factory` launcher falls back to it when the caller's active node is older — so the
 *  CLI always runs on its own Node 24 regardless of the caller's cwd, with no version-manager
 *  dependency at runtime. */
export function nodePathFile(): string {
  return join(stateRoot(), "node-path");
}

// ── Vendored Node runtime (managed installs only — a plain dev checkout uses the ambient node). ──
// A `curl | install.sh` install downloads the pinned official Node (see .node-version) into
// `<state>/runtime/<version>/` and points a STABLE `current` symlink at it. Everything that spawns
// node (the launchers, the launchd/systemd service, the supervisor's spawnServe) invokes node
// through that symlink, so re-provisioning a bumped Node is one atomic symlink flip — no service
// rewrite. `provisionNode()` (src/watchers/provision.ts) creates/flips it; the self-updater calls
// it whenever `.node-version` changes.

/** Root of the vendored Node runtimes: `<state>/runtime`. */
export function runtimeRoot(): string {
  return join(stateRoot(), "runtime");
}
/** A specific vendored Node version dir: `<state>/runtime/<version>`. */
export function runtimeVersionDir(version: string): string {
  return join(runtimeRoot(), version);
}
/** Stable symlink pointing at the active vendored Node version dir: `<state>/runtime/current`. */
export function runtimeCurrentLink(): string {
  return join(runtimeRoot(), "current");
}
/** Stable path to the vendored `node` binary, through the `current` symlink. This is what the
 *  node-path file / service point at, so a Node bump only moves the symlink. */
export function managedNodePath(): string {
  return join(runtimeCurrentLink(), "bin", "node");
}
/** Is the given node binary the vendored one (i.e. living under `<state>/runtime`)? Used to decide
 *  whether to bake the stable symlink path vs the concrete execPath. */
export function isManagedNode(execPath: string): boolean {
  const root = runtimeRoot();
  return execPath === root || execPath.startsWith(root + sep);
}
/** The node binary to (re)spawn/schedule with: the baked node-path if it resolves to a real binary
 *  (the vendored `runtime/current/bin/node` in a managed install — so a Node bump that flips the
 *  symlink propagates without rewriting anything), else the caller's own execPath (dev checkout).
 *  Falls back to execPath if the baked path is missing/stale so we never spawn a vanished node. */
export function resolvedNodePath(fallback: string): string {
  try {
    const baked = readFileSync(nodePathFile(), "utf8").trim();
    if (baked && existsSync(baked)) return baked;
  } catch {
    /* no baked path yet */
  }
  return fallback;
}

/** A repo's config folder (`<configDir>/repos/<name>/`) — where its config.yml + env live.
 *  Exposed for tools (e.g. the TUI config editor) that read/write the raw config.yml directly,
 *  without going through loadConfig's parse+validate (so they can edit an as-yet-invalid file and
 *  preserve YAML comments). */
export function repoConfigDir(name: string): string {
  return join(configDir(), "repos", name);
}

/** Every repo configured under `<configDir>/repos/<name>/config.yml`, sorted. The resident
 *  server discovers all of them on startup; the per-repo launchd model needed none of this. */
export function listConfiguredRepos(): string[] {
  const dir = join(configDir(), "repos");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "config.yml")))
    .map((d) => d.name)
    .sort();
}

/** Where the running `serve` process advertises itself: `{pid, port, version, startedAt}`.
 *  Written on listen, removed on graceful shutdown. CLI clients + the supervisor read it to
 *  find (and health-check) the server. */
export function serverInfoPath(): string {
  return join(stateRoot(), "server.json");
}

/** TCP port the server binds on 127.0.0.1 (override with HERDR_FACTORY_PORT). The bind itself
 *  is the single-instance guard — a second `serve` fails with EADDRINUSE and exits. */
export function serverPort(): number {
  const p = Number(process.env.HERDR_FACTORY_PORT);
  return Number.isInteger(p) && p > 0 ? p : 8765;
}

/** Server-wide (not per-repo) log dir — the supervisor's launchd stdout/err land here. */
export function serverLogsDir(): string {
  return join(stateRoot(), "logs");
}

/** Load a repo's env file (auth secrets etc.) as a raw map. Strictly PER-REPO — read only from
 *  `<configDir>/repos/<name>/env`. There is no shared/global secrets file. Same file + keys as the
 *  old Jira-shaped loader (JIRA_EMAIL/JIRA_API_TOKEN keep working verbatim); which keys a source
 *  needs is declared on its descriptor's secrets manifest. */
export function loadEnvMap(repoDir: string): Record<string, string> {
  return parseEnvFile(join(repoDir, "env"));
}

/** Merge key/values into `<repoDir>/env` (chmod 600). Only the keys provided are updated (a
 *  `undefined` value leaves the existing entry alone); others in the file are preserved.
 *  Counterpart to loadEnvMap, used by the TUI config editor so credentials don't have to be
 *  hand-created. */
export function saveEnvValues(repoDir: string, values: Record<string, string | undefined>): void {
  mkdirSync(repoDir, { recursive: true });
  const path = join(repoDir, "env");
  const env = parseEnvFile(path);
  for (const [k, v] of Object.entries(values)) if (v !== undefined) env[k] = v;
  const content = Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600); // ensure 600 even if the file already existed
}

/** The config.yml JSON Schema — derived from `RepoConfigSchema` (single source of truth) so editors
 *  (e.g. the YAML language server) give autocomplete + inline validation. Generated from the INPUT
 *  side (what the user writes); `.strict()` becomes `additionalProperties: false`, so unknown keys
 *  (the classic `agents`-on-a-`custom`-belt mixup, or a typo) are flagged live. Cross-field rules
 *  JSON Schema can't express — belt.source references, unique names, layout both-or-neither,
 *  workspace_name must contain {{work_id}}, match/prompt_file existence — are still enforced by
 *  loadConfig (with readable errors). */
export function configJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(RepoConfigSchema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  return {
    ...schema,
    title: "herdr-factory repo config (config.yml)",
    description:
      "Structural schema for a per-repo config.yml. Cross-field rules (belt.source refs, unique names, layout both-or-neither, workspace_name {{work_id}}, file existence) are validated at load time, not here.",
  };
}

/** Where the editor-facing JSON Schema is written. Each config.yml points at it relative to itself
 *  with a first-line modeline: `# yaml-language-server: $schema=../../config.schema.json`
 *  (repos/<name>/config.yml is two levels below this configDir file). */
export function configSchemaPath(): string {
  return join(configDir(), "config.schema.json");
}

/** Generate + write the config JSON Schema to configSchemaPath(); returns the path. */
export function writeConfigSchema(): string {
  const path = configSchemaPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(configJsonSchema(), null, 2)}\n`);
  return path;
}

export function loadConfig(repoName: string): Loaded {
  const cfgDir = configDir();
  const repoDir = join(cfgDir, "repos", repoName);
  const ymlPath = join(repoDir, "config.yml");
  if (!existsSync(ymlPath)) {
    throw new Error(`no config for repo "${repoName}" at ${ymlPath}`);
  }

  // safeParse + format the issues into a readable message — a raw ZodError stringifies to an
  // unreadable JSON dump (and the CLI just prints `e.message`). Path "belt.0.steps" etc.
  const result = RepoConfigSchema.safeParse(parseYaml(readFileSync(ymlPath, "utf8")));
  if (!result.success) {
    const detail = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`invalid config for repo "${repoName}" (${ymlPath}):\n${detail}`);
  }
  const parsed = result.data;
  const repoPath = expandHome(parsed.repo.path);
  assertMainCheckout(repoPath);

  const guidancePath = join(repoDir, "guidelines-prompt.md");
  const guidance = existsSync(guidancePath) ? readFileSync(guidancePath, "utf8") : undefined;

  const sources: WorkSourceConfig[] = parsed.work_sources.map((s) => ({
    name: s.name ?? s.type,
    type: s.type,
    cfg: descriptorFor(s.type).resolveConfig(s),
  }));
  const sourceTypeByName = new Map(sources.map((s) => [s.name, s.type]));

  // The engine's built-in prompt for a (sourceType, step): prompts/<type>/<step>.md if present,
  // else the shared prompts/<step>.md. Used for work_to_pull_request steps (the engine owns those).
  const shippedPrompt = (sourceType: SourceType, step: string): string => {
    const typed = fileURLToPath(new URL(`prompts/${sourceType}/${step}.md`, import.meta.url));
    const shared = fileURLToPath(new URL(`prompts/${step}.md`, import.meta.url));
    return readFileSync(existsSync(typed) ? typed : shared, "utf8");
  };
  // Resolve a belt-relative file (prompt_file / match) to an absolute path, asserting it exists.
  const resolveFile = (belt: string, what: string, p: string): string => {
    const abs = isAbsolute(p) ? p : join(repoDir, p);
    if (!existsSync(abs)) throw new Error(`belt "${belt}": ${what} not found: ${abs}`);
    return abs;
  };
  // Existence check for a `config`-sourced prompt_file (resolved against the config folder). A
  // `repo`-sourced prompt is read from the run's worktree at render time, so it can't be checked
  // here — a missing one surfaces (with a clear error) when the step is dispatched.
  const checkConfigPromptFile = (belt: string, label: string, source: "config" | "repo", promptFile: string): void => {
    if (source === "config") resolveFile(belt, label, promptFile);
  };

  // The engine steps of a work_to_pull_request belt (order = pipeline order):
  //   fix → evidence → review → pr
  // `evidence` captures + publishes visual proof and can bounce back to fix; `review` is a strict
  // read-only gate that passes forward or bounces back to fix; `pr` opens the PR + rides CI.
  const PR_STEPS = [
    { name: "fix", budget: parsed.limits.develop_budget_seconds, heartbeat: true, opensPr: false },
    { name: "evidence", budget: parsed.limits.evidence_budget_seconds, heartbeat: false, opensPr: false },
    { name: "review", budget: parsed.limits.review_budget_seconds, heartbeat: false, opensPr: false },
    { name: "pr", budget: parsed.limits.pr_budget_seconds, heartbeat: true, opensPr: true },
  ] as const;
  // Per-step capabilities for the w2pr pipeline (kept beside PR_STEPS so the pipeline shape lives in
  // one place; `bounce`/evidence are belt-agnostic once resolved onto StepConfig, so custom belts
  // can grow them later). evidence + review may send the run back to fix for rework.
  const PR_CAN_BOUNCE_TO: Record<string, string[]> = { evidence: ["fix"], review: ["fix"] };
  const PR_GATHERS_EVIDENCE = new Set<string>(["evidence"]);

  const belts: BeltConfig[] = parsed.belt.map((b) => {
    const sourceType = sourceTypeByName.get(b.source)!; // existence guaranteed by superRefine
    const base = {
      name: b.name,
      beltType: b.belt_type as BeltType,
      source: b.source,
      priority: b.priority,
      workspaceName: b.workspace_name,
      matchFile: b.match ? resolveFile(b.name, "match", b.match) : undefined,
      label: b.label,
    };
    if (b.belt_type === "work_to_pull_request") {
      const steps: StepConfig[] = PR_STEPS.flatMap((d) => {
        const agent = b.agents[d.name] ?? {};
        // `evidence` is opt-in + cooperative: it verifies fix's work using an EXISTING agent in the
        // user's layout, so it runs ONLY when a tab/pane targets that agent. With no tab/pane it is
        // SKIPPED entirely (fix → review → pr) — evidence never spawns its own agent. fix/review/pr
        // always run (they spawn a dedicated pane when unconfigured).
        if (d.name === "evidence" && !(agent.tab && agent.pane)) return [];
        // schema guarantees prompt_file_source is present when prompt_file is.
        if (agent.prompt_file) checkConfigPromptFile(b.name, `${d.name} prompt_file`, agent.prompt_file_source!, agent.prompt_file);
        return [{
          name: d.name,
          tab: agent.tab,
          pane: agent.pane,
          enginePrompt: shippedPrompt(sourceType, d.name),
          promptFile: agent.prompt_file,
          promptFileSource: agent.prompt_file_source,
          budgetSeconds: d.budget,
          heartbeat: d.heartbeat,
          opensPr: d.opensPr,
          gathersEvidence: PR_GATHERS_EVIDENCE.has(d.name),
          canBounceTo: PR_CAN_BOUNCE_TO[d.name] ?? [],
        }];
      });
      return { ...base, steps, watchPr: true, maxBounces: b.max_bounces };
    }
    const steps: StepConfig[] = b.steps.map((s) => {
      checkConfigPromptFile(b.name, `step "${s.name}" prompt_file`, s.prompt_file_source, s.prompt_file);
      return {
        name: s.name,
        tab: s.tab,
        pane: s.pane,
        promptFile: s.prompt_file,
        promptFileSource: s.prompt_file_source,
        budgetSeconds: s.budget_seconds ?? parsed.limits.step_budget_seconds,
        heartbeat: s.heartbeat, // schema default: false
        opensPr: false,
        gathersEvidence: false, // custom steps don't (yet) declare evidence/bounce — a fast-follow
        canBounceTo: [],
      };
    });
    return { ...base, steps, watchPr: false, maxBounces: b.max_bounces };
  });
  // Stable sort: equal priorities keep config order (V8 Array.sort is stable on Node >=24).
  belts.sort((a, b) => a.priority - b.priority);

  const root = stateRoot();
  const stateDir = join(root, repoName);

  const config: Config = {
    repoName,
    repo: { path: repoPath, baseRef: parsed.repo.base_ref, github: parsed.repo.github },
    limits: {
      maxActiveWorkspaces: parsed.limits.max_active_workspaces,
      attentionRenotifySeconds: parsed.limits.attention_renotify_seconds,
      developBudgetSeconds: parsed.limits.develop_budget_seconds,
      stallSeconds: parsed.limits.stall_seconds,
      reviewBudgetSeconds: parsed.limits.review_budget_seconds,
      evidenceBudgetSeconds: parsed.limits.evidence_budget_seconds,
      prBudgetSeconds: parsed.limits.pr_budget_seconds,
      maxBounces: parsed.limits.max_bounces,
      maxCaptureAttempts: parsed.limits.max_capture_attempts,
      stepBudgetSeconds: parsed.limits.step_budget_seconds,
      tickIntervalSeconds: parsed.limits.tick_interval_seconds,
      reconcileConcurrency: parsed.limits.reconcile_concurrency,
      maxClaimsPerTick: parsed.limits.max_claims_per_tick,
      layoutWaitSeconds: parsed.limits.layout_wait_seconds,
    },
    sources,
    belts,
    evidence: parsed.evidence
      ? {
          bucket: parsed.evidence.bucket,
          region: parsed.evidence.region,
          cloudfrontDomain: parsed.evidence.cloudfront_domain,
          keyPrefix: parsed.evidence.key_prefix,
          githubUsername: parsed.evidence.github_username,
          profile: parsed.evidence.profile,
        }
      : undefined,
    guidance,
    paths: {
      configDir: cfgDir,
      repoDir,
      stateRoot: root,
      stateDir,
      dbPath: join(root, "herdr-factory.db"),
      logsDir: join(stateDir, "logs"),
    },
  };

  return { config, env: loadEnvMap(repoDir) };
}
