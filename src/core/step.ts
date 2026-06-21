import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Deps, SourceRuntime } from "./deps.ts";
import type { Phase, Run, RunStep, StepName } from "../types.ts";

export const CLAUDE_FLAGS = ["--dangerously-skip-permissions"];
export const CLI_PATH = fileURLToPath(new URL("../../bin/herdr-factory", import.meta.url));
const MEMORY_DIR = ".memory/herdr-factory";

/** One pipeline step: which phase runs it, which phase follows, and whether the
 *  commit-HEAD stall heartbeat applies (review may legitimately make no commits). */
export interface StepDescriptor {
  name: StepName;
  phase: Phase;
  heartbeat: boolean; // commit-HEAD stall heartbeat applies? (review may legitimately make no commits)
}

/** The pipeline order — the single source of truth for step sequencing (order = array index). */
export const STEPS: StepDescriptor[] = [
  { name: "fix", phase: "fixing", heartbeat: true },
  { name: "review", phase: "auto_review", heartbeat: false },
  { name: "pr", phase: "pr_round", heartbeat: true },
];

export const stepForPhase = (phase: Phase): StepDescriptor | undefined => STEPS.find((s) => s.phase === phase);

const indexOfStep = (step: StepName): number => STEPS.findIndex((s) => s.name === step);

export const priorStepName = (step: StepName): StepName | undefined => {
  const i = indexOfStep(step);
  return i > 0 ? STEPS[i - 1]!.name : undefined;
};

/** Descriptor of the step after `step`, or undefined if it's the last (→ human reviewing). */
export const nextStep = (step: StepName): StepDescriptor | undefined => {
  const i = indexOfStep(step);
  return i >= 0 && i < STEPS.length - 1 ? STEPS[i + 1] : undefined;
};

const dispatchPrompt = (step: StepName): string =>
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
 *  local_markdown snapshots the file to task.md. Idempotent (the source guards against
 *  re-materializing) and best-effort (it logs rather than throwing), so it's safe to call on
 *  every claiming tick while we wait for the step's layout pane to come up. */
export async function materializeWork(deps: Deps, run: Run, src: SourceRuntime): Promise<void> {
  const worktree = run.worktreePath;
  if (!worktree) throw new Error(`${run.ticketKey}: no worktree path`);
  const mem = join(worktree, MEMORY_DIR);
  mkdirSync(mem, { recursive: true });
  try {
    await src.client.materialize(run.ticketKey, mem, deps.log);
  } catch {
    deps.log("warn", `${run.ticketKey}: materialize had issues`);
  }
}

/** Standard footer appended to every step prompt: where its inputs are, and the
 *  mandatory finish protocol (write a handoff note, then signal step-done). */
function footer(step: StepName, prior: RunStep | null, stepDoneCmd: string): string {
  const inputs = prior
    ? `\n\n## Inputs from the previous step (${prior.step})\n` +
      `- Read the handoff note first: \`${MEMORY_DIR}/handoff-${prior.step}.md\`.\n` +
      `- The previous agent ran in herdr pane \`${prior.paneId}\` (claude session \`${prior.sessionId ?? "?"}\`). ` +
      `If the handoff note isn't enough, query it on demand: \`herdr agent read ${prior.paneId} --source recent\`, ` +
      `read its session transcript, or ask it directly with \`herdr agent send ${prior.paneId} "<question>"\`.\n`
    : "\n\n## Inputs\nThis is the first step — start from the ticket.\n";
  return (
    inputs +
    `\n## Finishing this step (required)\n` +
    `1. Write your handoff note to \`${MEMORY_DIR}/handoff-${step}.md\` — what you did, key decisions and why, ` +
    `anything uncertain, and what the next step should verify.\n` +
    `2. Then run \`${stepDoneCmd}\` and stop. Do NOT change the work item's status — the ` +
    `dispatcher owns all status transitions.\n`
  );
}

/** Render a step's prompt (config prompt_file contents + tokens + guidance + footer) and
 *  write it into the worktree's .memory for the agent to read. Function replacers avoid
 *  `$`-pattern interpretation. */
export function renderStepPrompt(deps: Deps, run: Run, src: SourceRuntime, step: StepName, prior: RunStep | null): void {
  const worktree = run.worktreePath;
  if (!worktree) throw new Error(`${run.ticketKey}: no worktree path`);
  // The step-done command carries --source so the signal resolves to the right run even when two
  // sources share a key (the worker only knows its key, via HERDR_FACTORY_TICKET).
  const stepDoneCmd = `${CLI_PATH} --repo ${deps.config.repoName} step-done ${run.ticketKey} ${step} --source ${src.name}`;
  // Where the work item's spec lives — per source type (Jira → ticket.json; local_markdown → task.md).
  const workDoc = src.type === "jira" ? `${MEMORY_DIR}/ticket.json` : `${MEMORY_DIR}/task.md`;
  const sub: Record<string, string> = {
    "@@KEY@@": run.ticketKey,
    "@@REPO@@": deps.config.repoName,
    "@@TYPE@@": run.issueType ?? "",
    "@@SUMMARY@@": run.summary ?? "",
    "@@BRANCH@@": run.branch ?? "",
    "@@WORKTREE@@": worktree,
    "@@STEP@@": step,
    "@@MEMORY_DIR@@": MEMORY_DIR,
    "@@WORK_DOC@@": workDoc,
    "@@EVIDENCE_DIR@@": `${MEMORY_DIR}/evidence`,
    "@@CLI@@": CLI_PATH,
    "@@HANDOFF_IN@@": prior ? `${MEMORY_DIR}/handoff-${prior.step}.md` : "(none — first step)",
    "@@HANDOFF_OUT@@": `${MEMORY_DIR}/handoff-${step}.md`,
    "@@PRIOR_PANE@@": prior?.paneId ?? "(none)",
    "@@PRIOR_SESSION@@": prior?.sessionId ?? "(none)",
    "@@STEP_DONE_CMD@@": stepDoneCmd,
  };
  let out = src.agents[step].prompt;
  for (const [token, value] of Object.entries(sub)) out = out.replaceAll(token, () => value);
  if (deps.config.guidance) out += `\n\n## Repo-specific guidance\n\n${deps.config.guidance}\n`;
  out += footer(step, prior, stepDoneCmd);
  const mem = join(worktree, MEMORY_DIR);
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, `prompt-${step}.md`), out);
}

/**
 * Spawn (or hand off to) the agent for `step`. Renders + writes its prompt (wiring in the
 * prior step's handoff + pane/session for on-demand query), then dispatches:
 *   - `ready`  → records the pane on the run_step and as the run's latest pane, flags focus.
 *   - `waiting`→ the configured layout pane isn't up yet; nothing is recorded. The run_step's
 *     `started_at` (stamped on first touch below) times the bounded wait; the caller decides
 *     whether to retry next tick or escalate to attention.
 */
export async function spawnStep(deps: Deps, run: Run, src: SourceRuntime, step: StepName): Promise<DispatchResult> {
  const workspaceId = run.workspaceId;
  const worktree = run.worktreePath;
  if (!workspaceId || !worktree) throw new Error(`${run.ticketKey}: missing workspace/worktree`);
  const cfg = src.agents[step];

  // Capture the prior step's session id at handoff time (herdr only knows it once the
  // prior agent has reported in) so this step's prompt can point at it.
  const prevName = priorStepName(step);
  let prior = prevName ? (deps.store.getRunStep(run.id, prevName) ?? null) : null;
  if (prior && !prior.sessionId && prior.paneId) {
    const sid = await deps.herdr.agentSessionId(prior.paneId);
    if (sid) prior = deps.store.upsertRunStep(run.id, prevName!, { sessionId: sid });
  }

  renderStepPrompt(deps, run, src, step, prior);

  // Ensure the step row exists so its started_at clock runs from the first attempt — this is
  // what bounds the layout wait across ticks. (started_at is set to now() on first insert and
  // only reset below once we actually dispatch.)
  deps.store.upsertRunStep(run.id, step);

  const result = await dispatchToLayout(deps, {
    workspaceId,
    worktree,
    tab: cfg.tab,
    pane: cfg.pane,
    prompt: dispatchPrompt(step),
    paneName: `${step}:${run.ticketKey}`,
    ticketKey: run.ticketKey,
  });
  if (result.status === "waiting") return result; // still waiting on the user's layout pane

  // Dispatched. Reset started_at so the per-step budget is measured from now (per attempt,
  // not cumulatively across crash-recovery re-spawns or the preceding layout wait).
  deps.store.upsertRunStep(run.id, step, { paneId: result.paneId, startedAt: deps.now() });
  deps.store.updateRun(run.id, { paneId: result.paneId }); // latest active pane (reviewing/resolver reuse it)
  deps.store.recordEvent({
    runId: run.id,
    repo: deps.config.repoName,
    ticketKey: run.ticketKey,
    type: "step_spawned",
    detail: { step, paneId: result.paneId },
  });
  // Mark that the active step changed. The actual focus shift is deferred to
  // applyPendingFocus, which brings this pane to the front only when the user is already
  // viewing THIS worktree on one of its pipeline panes — never stealing focus from another
  // worktree, and never yanking the user off an unrelated pane.
  deps.store.updateRun(run.id, { focusPending: true });
  return result;
}
