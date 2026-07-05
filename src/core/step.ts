import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StepConfig } from "../config.ts";
import type { BeltRuntime, Deps, SourceRuntime } from "./deps.ts";
import type { Run, RunStep } from "../types.ts";
import { telemetrySpan } from "../telemetry/index.ts";

export const CLAUDE_FLAGS = ["--dangerously-skip-permissions"];
export const CLI_PATH = fileURLToPath(new URL("../../bin/herdr-factory", import.meta.url));
export const MEMORY_DIR = ".memory/herdr-factory";

// --- belt step sequencing (belt.steps is the ordered source of truth) -------

export const stepByName = (belt: BeltRuntime, name: string | null): StepConfig | undefined =>
  name == null ? undefined : belt.steps.find((s) => s.name === name);

/** The belt's first step (every belt has ≥1 — enforced by config). */
export const firstStep = (belt: BeltRuntime): StepConfig => belt.steps[0]!;

export const indexOfStep = (belt: BeltRuntime, name: string): number => belt.steps.findIndex((s) => s.name === name);

/** The step before `name` in this belt, or undefined if it's the first. */
export const priorStep = (belt: BeltRuntime, name: string): StepConfig | undefined => {
  const i = indexOfStep(belt, name);
  return i > 0 ? belt.steps[i - 1] : undefined;
};

/** The step after `name`, or undefined if it's the belt's last step (→ reviewing/teardown). */
export const nextStep = (belt: BeltRuntime, name: string): StepConfig | undefined => {
  const i = indexOfStep(belt, name);
  return i >= 0 && i < belt.steps.length - 1 ? belt.steps[i + 1] : undefined;
};

const dispatchPrompt = (step: string): string =>
  `Read ${MEMORY_DIR}/prompt-${step}.md in this worktree and follow it exactly. This is an autonomous task — do not pause to ask for confirmation.`;

/** Result of one dispatch attempt: the agent got the prompt (`ready` + its pane), or the
 *  configured layout pane isn't up yet (`waiting`) so the caller should retry on a later tick. */
export type DispatchResult = { status: "ready"; paneId: string } | { status: "waiting" };

/**
 * Deliver `prompt` to a step's agent. Two modes, chosen by whether a `tab`/`pane` is configured:
 *
 *  - **Configured** (the user's layout owns this pane): find that pane and require an agent
 *    that is present AND idle, then `agent send` the prompt to it (agent-agnostic — claude,
 *    opencode, …). If the pane isn't up yet, or its agent is still busy starting up, return
 *    `waiting` — we NEVER spawn our own when a tab/pane is configured; the caller waits (and
 *    eventually escalates to attention). This is what lets the user's auto-spawned layout
 *    (setup commands, dev servers, agent startup) settle before work begins.
 *  - **Not configured** (no tab/pane): spawn a dedicated claude pane ourselves. This is the
 *    only path that creates a pane.
 *
 * Renames the target pane to `paneName`. Shared by all step agents.
 */
export async function dispatchToLayout(
  deps: Deps,
  opts: { workspaceId: string; worktree: string; tab?: string; pane?: string; prompt: string; paneName: string; ticketKey: string },
): Promise<DispatchResult> {
  return telemetrySpan(
    "step.dispatch",
    {
      repo: deps.config.repoName,
      "work.key": opts.ticketKey,
      "herdr.workspace_id": opts.workspaceId,
      "step.layout.configured": opts.tab != null && opts.pane != null,
      "step.layout.tab": opts.tab,
      "step.layout.pane": opts.pane,
    },
    () => dispatchToLayoutImpl(deps, opts),
  );
}

async function dispatchToLayoutImpl(
  deps: Deps,
  opts: { workspaceId: string; worktree: string; tab?: string; pane?: string; prompt: string; paneName: string; ticketKey: string },
): Promise<DispatchResult> {
  if (opts.tab && opts.pane) {
    const target = await deps.herdr.tabPaneByLabel(opts.workspaceId, opts.tab, opts.pane);
    if (!target) return { status: "waiting" }; // the layout hasn't created this tab/pane yet
    if ((await deps.herdr.paneState(target)) !== "idle") return { status: "waiting" }; // no agent, or still busy
    await deps.sleep(2000); // settle so the first keystrokes aren't dropped
    await deps.herdr.agentSend(target, opts.prompt);
    await deps.herdr.paneSendKeys(target, "Enter");
    await deps.herdr.agentRename(target, opts.paneName);
    deps.log("info", `${opts.ticketKey}: dispatched to layout pane ${target} (${opts.tab}/${opts.pane})`);
    return { status: "ready", paneId: target };
  }

  // No tab/pane configured for this step → spawn our own dedicated pane.
  const target = await deps.herdr.agentStart({
    workspaceId: opts.workspaceId,
    cwd: opts.worktree,
    argv: ["claude", ...CLAUDE_FLAGS, opts.prompt],
    env: { HERDR_FACTORY_TICKET: opts.ticketKey },
  });
  if (!target) throw new Error(`${opts.ticketKey}: failed to spawn dedicated agent (no tab/pane configured)`);
  await deps.herdr.agentRename(target, opts.paneName);
  deps.log("info", `${opts.ticketKey}: no tab/pane configured — spawned dedicated pane ${target}`);
  return { status: "ready", paneId: target };
}

/** Materialize the work item (its work doc + any media) into the worktree's .memory for the
 *  agents to read. Delegates to the source: Jira writes ticket.json + image/video attachments;
 *  local_markdown snapshots a file to task.md or copies a directory item whole to task/. Idempotent (the source guards against
 *  re-materializing) and best-effort (it logs rather than throwing), so it's safe to call on
 *  every claiming tick while we wait for the step's layout pane to come up. */
export async function materializeWork(deps: Deps, run: Run, src: SourceRuntime): Promise<void> {
  return telemetrySpan(
    "step.materialize_work",
    { repo: deps.config.repoName, "run.id": run.id, "work.key": run.ticketKey, "work.source": src.name, "source.type": src.type },
    async () => {
      const worktree = run.worktreePath;
      if (!worktree) throw new Error(`${run.ticketKey}: no worktree path`);
      const mem = join(worktree, MEMORY_DIR);
      mkdirSync(mem, { recursive: true });
      try {
        await src.client.materialize(run.ticketKey, mem, deps.log);
      } catch {
        deps.log("warn", `${run.ticketKey}: materialize had issues`);
      }
    },
  );
}

/** The handover scaffold appended to EVERY step prompt (work_to_pull_request + custom alike): which
 *  belt/step this is and the full step sequence, how to read the prior step's handoff + query its
 *  agent, and the mandatory finish protocol (write a handoff note, then signal step-done). This is
 *  the "you're working in herdr, here are the other agents in this belt" wiring — the only thing the
 *  engine injects on top of the step's own prompt body. */
function scaffold(
  belt: BeltRuntime,
  step: StepConfig,
  prior: RunStep | null,
  stepDoneCmd: string,
  askHumanCmd: string,
  bounceCmd: string,
  bounceTarget: string | undefined,
): string {
  const seq = belt.steps.map((s) => (s.name === step.name ? `**${s.name}** (you)` : s.name)).join(" → ");
  const inputs = prior
    ? `\n\n## Input from the previous step (${prior.step})\n` +
      `- Read its handoff note first: \`${MEMORY_DIR}/handoff-${prior.step}.md\`.\n` +
      `- That agent ran in herdr pane \`${prior.paneId}\` (claude session \`${prior.sessionId ?? "?"}\`). ` +
      `If the handoff note isn't enough, query it on demand: \`herdr agent read ${prior.paneId} --source recent\`, ` +
      `read its session transcript, or ask it directly with \`herdr agent send ${prior.paneId} "<question>"\`.\n`
    : "\n\n## Input\nThis is the first step of the belt — start from the work item.\n";
  return (
    `\n\n## You are an agent in a herdr-factory belt\n` +
    `You are the **${step.name}** step of the **${belt.name}** belt. The belt runs these steps in order: ${seq}. ` +
    `Each step is a separate agent in its own herdr pane; you hand work forward via a handoff note (and can query earlier agents directly).\n` +
    inputs +
    `\n## Asking a human for guidance\n` +
    `If you are blocked by ambiguous requirements, missing source material, impossible verification, or conflicting evidence, do NOT guess and do NOT run step-done. ` +
    `Write a concise question to \`${MEMORY_DIR}/human-question-${step.name}.md\`, then run \`${askHumanCmd}\` and stop. ` +
    `The dispatcher will post the question through the work source, wait for a human reply, write the answer under \`${MEMORY_DIR}/human-replies/\`, and resume this same step automatically. ` +
    `If \`${MEMORY_DIR}/human-replies/\` already exists when you start or resume, read its files before continuing.\n` +
    (bounceCmd && bounceTarget
      ? `\n## Sending the work back for rework\n` +
        `If your work on this step shows the previous work is NOT acceptable — e.g. evidence proves the issue isn't actually fixed, ` +
        `the change is wrong, or a required behaviour is missing — do NOT run step-done and do NOT try to fix it here. Instead: ` +
        `write concrete, actionable findings (what's wrong and what must change) to \`${MEMORY_DIR}/bounce-${step.name}.md\`, ` +
        `then run \`${bounceCmd}\` and stop. This sends the run back to the **${bounceTarget}** step to do the work. ` +
        `Write specific, reproducible findings so the loop converges quickly. ` +
        `(A per-run bounce cap is only a safety backstop against endless oscillation — once exceeded the run parks for a human.)\n`
      : "") +
    `\n## Finishing this step (required)\n` +
    `1. Write your handoff note to \`${MEMORY_DIR}/handoff-${step.name}.md\` — what you did, key decisions and why, ` +
    `anything uncertain, and what the next step should verify.\n` +
    `2. Then run \`${stepDoneCmd}\` and stop. Do NOT change the work item's status — the dispatcher owns all status transitions.\n`
  );
}

/** Assemble a step's prompt body at render time (before tokens/scaffold): the engine base
 *  (work_to_pull_request steps) plus, if the step configures a `promptFile`, the user prompt read
 *  from `config` (the repo's config folder) or `repo` (the run's worktree). For a w2pr step the
 *  user prompt AUGMENTS the engine base; for a custom step (no base) it IS the whole body. */
function stepBody(deps: Deps, run: Run, step: StepConfig): string {
  let userPrompt = "";
  if (step.promptFile) {
    if (step.promptFileSource === "repo" && !run.worktreePath) {
      throw new Error(`${run.ticketKey}: ${step.name} has a repo-sourced prompt_file but no worktree yet`);
    }
    const root = step.promptFileSource === "repo" ? run.worktreePath! : deps.config.paths.repoDir;
    const path = isAbsolute(step.promptFile) ? step.promptFile : join(root, step.promptFile);
    try {
      userPrompt = readFileSync(path, "utf8");
    } catch {
      throw new Error(`${run.ticketKey}: ${step.name} prompt_file not found (${step.promptFileSource}): ${path}`);
    }
  }
  if (step.enginePrompt === undefined) return userPrompt; // custom: the user prompt is the body
  // work_to_pull_request: the engine base, augmented by the optional user prompt.
  return userPrompt.trim()
    ? `${step.enginePrompt.trimEnd()}\n\n## Additional repo-specific instructions for this step\n\n${userPrompt.trim()}\n`
    : step.enginePrompt;
}

/** Render a step's prompt (its assembled body + tokens + guidance + handover scaffold) and write it
 *  into the worktree's .memory for the agent to read. Function replacers avoid `$`-pattern
 *  interpretation. */
export async function renderStepPrompt(
  deps: Deps,
  run: Run,
  belt: BeltRuntime,
  src: SourceRuntime,
  step: StepConfig,
  prior: RunStep | null,
): Promise<void> {
  return telemetrySpan(
    "step.render_prompt",
    { repo: deps.config.repoName, "run.id": run.id, "work.key": run.ticketKey, "work.source": src.name, belt: belt.name, step: step.name },
    () => renderStepPromptImpl(deps, run, belt, src, step, prior),
  );
}

async function renderStepPromptImpl(
  deps: Deps,
  run: Run,
  belt: BeltRuntime,
  src: SourceRuntime,
  step: StepConfig,
  prior: RunStep | null,
): Promise<void> {
  const worktree = run.worktreePath;
  if (!worktree) throw new Error(`${run.ticketKey}: no worktree path`);
  // The step-done command carries --source so the signal resolves to the right run even when two
  // sources share a key (the worker only knows its key, via HERDR_FACTORY_TICKET).
  const stepDoneCmd = `${CLI_PATH} --repo ${deps.config.repoName} step-done ${run.ticketKey} ${step.name} --source ${src.name}`;
  const askHumanCmd = `${CLI_PATH} --repo ${deps.config.repoName} ask-human ${run.ticketKey} ${step.name} --source ${src.name} --question-file ${MEMORY_DIR}/human-question-${step.name}.md`;
  // Publishes @@EVIDENCE_DIR@@ to S3/CloudFront and prints the public URLs (no-op if `evidence:` is
  // unconfigured). Available to every step; the evidence step is the one that uses it.
  const evidenceUploadCmd = `${CLI_PATH} --repo ${deps.config.repoName} evidence-upload ${run.ticketKey} --source ${src.name}`;
  // For a step that may bounce (evidence/review), a ready-made command that returns the run to its
  // first `canBounceTo` target with a findings file. Empty for steps that can't bounce.
  const bounceTarget = step.canBounceTo[0];
  const bounceCmd = bounceTarget
    ? `${CLI_PATH} --repo ${deps.config.repoName} bounce ${run.ticketKey} ${bounceTarget} --source ${src.name} --reason-file ${MEMORY_DIR}/bounce-${step.name}.md`
    : "";
  // Where the work item's spec lives + how to describe it — the SOURCE owns this (workDoc pairs
  // with its materialize; the engine never branches on source type). It may stat the worktree's
  // .memory to disambiguate layouts (e.g. local_markdown's task/ vs task.md).
  const wd = await src.client.workDoc(join(worktree, MEMORY_DIR));
  const workDoc = `${MEMORY_DIR}/${wd.path}`;
  const workDocKind = wd.kind;
  const sub: Record<string, string> = {
    "@@KEY@@": run.ticketKey,
    "@@REPO@@": deps.config.repoName,
    "@@BELT@@": belt.name,
    "@@STEPS@@": belt.steps.map((s) => s.name).join(" → "),
    "@@TYPE@@": run.issueType ?? "",
    "@@SUMMARY@@": run.summary ?? "",
    "@@BRANCH@@": run.branch ?? "",
    "@@WORKTREE@@": worktree,
    "@@STEP@@": step.name,
    "@@MEMORY_DIR@@": MEMORY_DIR,
    "@@WORK_DOC@@": workDoc,
    "@@WORK_DOC_KIND@@": workDocKind,
    "@@EVIDENCE_DIR@@": `${MEMORY_DIR}/evidence`,
    "@@EVIDENCE_UPLOAD_CMD@@": evidenceUploadCmd,
    "@@BOUNCE_CMD@@": bounceCmd,
    "@@BOUNCE_TARGET@@": bounceTarget ?? "",
    "@@CLI@@": CLI_PATH,
    "@@HANDOFF_IN@@": prior ? `${MEMORY_DIR}/handoff-${prior.step}.md` : "(none — first step)",
    "@@HANDOFF_OUT@@": `${MEMORY_DIR}/handoff-${step.name}.md`,
    "@@PRIOR_PANE@@": prior?.paneId ?? "(none)",
    "@@PRIOR_SESSION@@": prior?.sessionId ?? "(none)",
    "@@STEP_DONE_CMD@@": stepDoneCmd,
  };
  let out = stepBody(deps, run, step);
  for (const [token, value] of Object.entries(sub)) out = out.replaceAll(token, () => value);
  if (deps.config.guidance) out += `\n\n## Repo-specific guidance\n\n${deps.config.guidance}\n`;
  out += scaffold(belt, step, prior, stepDoneCmd, askHumanCmd, bounceCmd, bounceTarget);
  // If a later step bounced the run back to this step, a feedback note is waiting — surface it up
  // top so the (re-dispatched) agent reads it before anything else.
  if (existsSync(join(worktree, MEMORY_DIR, `feedback-${step.name}.md`))) {
    out =
      `## ⚠ Rework requested — READ THIS FIRST\n\n` +
      `A later step sent this work back to you. Read \`${MEMORY_DIR}/feedback-${step.name}.md\` in this worktree ` +
      `and address its findings before doing anything else, then finish this step as normal.\n\n---\n\n` +
      out;
  }
  const mem = join(worktree, MEMORY_DIR);
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, `prompt-${step.name}.md`), out);
}

/**
 * Spawn (or hand off to) the agent for `stepName`. Renders + writes its prompt (wiring in the
 * prior step's handoff + pane/session for on-demand query), then dispatches:
 *   - `ready`  → records the pane on the run_step and as the run's latest pane, flags focus.
 *   - `waiting`→ the configured layout pane isn't up yet; nothing is recorded. The run_step's
 *     `started_at` (stamped on first touch below) times the bounded wait; the caller decides
 *     whether to retry next tick or escalate to attention.
 */
export async function spawnStep(
  deps: Deps,
  run: Run,
  belt: BeltRuntime,
  src: SourceRuntime,
  stepName: string,
): Promise<DispatchResult> {
  return telemetrySpan(
    "step.spawn",
    { repo: deps.config.repoName, "run.id": run.id, "work.key": run.ticketKey, "work.source": src.name, belt: belt.name, step: stepName },
    () => spawnStepImpl(deps, run, belt, src, stepName),
  );
}

async function spawnStepImpl(
  deps: Deps,
  run: Run,
  belt: BeltRuntime,
  src: SourceRuntime,
  stepName: string,
): Promise<DispatchResult> {
  const workspaceId = run.workspaceId;
  const worktree = run.worktreePath;
  if (!workspaceId || !worktree) throw new Error(`${run.ticketKey}: missing workspace/worktree`);
  const step = stepByName(belt, stepName);
  if (!step) throw new Error(`${run.ticketKey}: belt "${belt.name}" has no step "${stepName}"`);

  // Capture the prior step's session id at handoff time (herdr only knows it once the
  // prior agent has reported in) so this step's prompt can point at it. Best-effort
  // enrichment — herdr being briefly unreachable must not abort the dispatch itself.
  const prev = priorStep(belt, stepName);
  let prior = prev ? (deps.store.getRunStep(run.id, prev.name) ?? null) : null;
  if (prior && !prior.sessionId && prior.paneId) {
    const sid = await deps.herdr.agentSessionId(prior.paneId).catch(() => null);
    if (sid) prior = deps.store.upsertRunStep(run.id, prev!.name, { sessionId: sid });
  }

  await renderStepPrompt(deps, run, belt, src, step, prior);

  // Ensure the step row exists so its started_at clock runs from the first attempt — this is
  // what bounds the layout wait across ticks. (started_at is set to now() on first insert and
  // only reset below once we actually dispatch.)
  deps.store.upsertRunStep(run.id, stepName);

  const result = await dispatchToLayout(deps, {
    workspaceId,
    worktree,
    tab: step.tab,
    pane: step.pane,
    prompt: dispatchPrompt(stepName),
    paneName: `${stepName}:${run.ticketKey}`,
    ticketKey: run.ticketKey,
  });
  if (result.status === "waiting") return result; // still waiting on the user's layout pane

  // Dispatched. Reset started_at so the per-step budget is measured from now (per attempt,
  // not cumulatively across crash-recovery re-spawns or the preceding layout wait), and clear
  // any pending absence confirmation — this pane is definitionally alive right now.
  deps.store.upsertRunStep(run.id, stepName, { paneId: result.paneId, startedAt: deps.now(), absentAt: null });
  deps.store.updateRun(run.id, { paneId: result.paneId }); // latest active pane (reviewing/resolver reuse it)
  deps.store.recordEvent({
    runId: run.id,
    repo: deps.config.repoName,
    ticketKey: run.ticketKey,
    type: "step_spawned",
    detail: { step: stepName, paneId: result.paneId },
  });
  // Mark that the active step changed. The actual focus shift is deferred to
  // applyPendingFocus, which brings this pane to the front only when the user is already
  // viewing THIS worktree on one of its pipeline panes — never stealing focus from another
  // worktree, and never yanking the user off an unrelated pane.
  deps.store.updateRun(run.id, { focusPending: true });
  return result;
}
