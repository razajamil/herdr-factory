import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Deps } from "./deps.ts";
import type { Phase, Run, RunStep, StepName } from "../types.ts";

export const CLAUDE_FLAGS = ["--dangerously-skip-permissions"];
export const CLI_PATH = fileURLToPath(new URL("../../bin/herdr-factory", import.meta.url));
const LAYOUT_WAIT_SEC = 120;
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
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

/**
 * Dispatch the given `prompt` to the agent in the layout's `tab`/`pane`. Agent-agnostic:
 * `herdr agent send` delivers the prompt to whatever agent the layout put there (claude,
 * opencode, …). Fallbacks for the no-layout/degraded case only: if the pane exists but has
 * no agent, run `claude` in it; if the pane never appears, spawn a dedicated claude pane.
 * Renames the pane to `paneName` and returns its id. Shared by all step agents.
 */
export async function dispatchToLayout(
  deps: Deps,
  opts: { workspaceId: string; worktree: string; tab: string; pane: string; prompt: string; paneName: string; ticketKey: string },
): Promise<string> {
  let target: string | null = null;
  for (let waited = 0; waited < LAYOUT_WAIT_SEC; waited += 4) {
    target = await deps.herdr.tabPaneByLabel(opts.workspaceId, opts.tab, opts.pane);
    if (target && (await deps.herdr.paneAlive(target))) break; // any agent (claude/opencode) is ready
    await deps.sleep(4000);
  }

  if (target) {
    if (await deps.herdr.paneAlive(target)) {
      await deps.sleep(2000); // settle so the first keystrokes aren't dropped
      await deps.herdr.agentSend(target, opts.prompt);
      await deps.herdr.paneSendKeys(target, "Enter");
      deps.log("info", `${opts.ticketKey}: dispatched to layout pane ${target} (${opts.tab}/${opts.pane})`);
    } else {
      // No agent in the configured pane (layout not applied) — start claude in it ourselves.
      await deps.herdr.paneRun(target, `claude ${CLAUDE_FLAGS.join(" ")} ${JSON.stringify(opts.prompt)}`);
      deps.log("info", `${opts.ticketKey}: no agent in ${opts.tab}/${opts.pane} — started claude in ${target}`);
    }
  } else {
    target = await deps.herdr.agentStart({
      workspaceId: opts.workspaceId,
      cwd: opts.worktree,
      argv: ["claude", ...CLAUDE_FLAGS, opts.prompt],
      env: { HERDR_FACTORY_TICKET: opts.ticketKey },
    });
    if (!target) throw new Error(`${opts.ticketKey}: failed to dispatch agent to ${opts.tab}/${opts.pane}`);
    deps.log("info", `${opts.ticketKey}: agent spawned in dedicated pane ${target}`);
  }

  await deps.herdr.agentRename(target, opts.paneName);
  return target;
}

/** Fetch ticket JSON + images into the worktree's .memory (once per run, at claiming). */
export async function materializeTicket(deps: Deps, run: Run): Promise<void> {
  const worktree = run.worktreePath;
  if (!worktree) throw new Error(`${run.ticketKey}: no worktree path`);
  const mem = join(worktree, MEMORY_DIR);
  mkdirSync(join(mem, "images"), { recursive: true });
  try {
    const issue = await deps.jira.getIssue(run.ticketKey);
    writeFileSync(join(mem, "ticket.json"), JSON.stringify(issue, null, 2));
  } catch {
    deps.log("warn", `${run.ticketKey}: could not save ticket.json`);
  }
  try {
    await deps.jira.downloadImages(run.ticketKey, join(mem, "images"), MAX_IMAGES, MAX_IMAGE_BYTES);
  } catch {
    deps.log("warn", `${run.ticketKey}: image download had issues`);
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
    `2. Then run \`${stepDoneCmd}\` and stop. Do NOT transition the Jira ticket.\n`
  );
}

/** Render a step's prompt (config prompt_file contents + tokens + guidance + footer) and
 *  write it into the worktree's .memory for the agent to read. Function replacers avoid
 *  `$`-pattern interpretation. */
export function renderStepPrompt(deps: Deps, run: Run, step: StepName, prior: RunStep | null): void {
  const worktree = run.worktreePath;
  if (!worktree) throw new Error(`${run.ticketKey}: no worktree path`);
  const stepDoneCmd = `${CLI_PATH} --repo ${deps.config.repoName} step-done ${run.ticketKey} ${step}`;
  const sub: Record<string, string> = {
    "@@KEY@@": run.ticketKey,
    "@@REPO@@": deps.config.repoName,
    "@@TYPE@@": run.issueType ?? "",
    "@@SUMMARY@@": run.summary ?? "",
    "@@BRANCH@@": run.branch ?? "",
    "@@WORKTREE@@": worktree,
    "@@STEP@@": step,
    "@@MEMORY_DIR@@": MEMORY_DIR,
    "@@EVIDENCE_DIR@@": `${MEMORY_DIR}/evidence`,
    "@@CLI@@": CLI_PATH,
    "@@HANDOFF_IN@@": prior ? `${MEMORY_DIR}/handoff-${prior.step}.md` : "(none — first step)",
    "@@HANDOFF_OUT@@": `${MEMORY_DIR}/handoff-${step}.md`,
    "@@PRIOR_PANE@@": prior?.paneId ?? "(none)",
    "@@PRIOR_SESSION@@": prior?.sessionId ?? "(none)",
    "@@STEP_DONE_CMD@@": stepDoneCmd,
  };
  let out = deps.config.agents[step].prompt;
  for (const [token, value] of Object.entries(sub)) out = out.replaceAll(token, () => value);
  if (deps.config.guidance) out += `\n\n## Repo-specific guidance\n\n${deps.config.guidance}\n`;
  out += footer(step, prior, stepDoneCmd);
  const mem = join(worktree, MEMORY_DIR);
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, `prompt-${step}.md`), out);
}

/**
 * Spawn the agent for `step` into its configured pane. Renders + writes its prompt
 * (wiring in the prior step's handoff + pane/session for on-demand query), dispatches,
 * records the pane on the run_step and as the run's latest pane. Returns the pane id.
 */
export async function spawnStep(deps: Deps, run: Run, step: StepName): Promise<string> {
  const workspaceId = run.workspaceId;
  const worktree = run.worktreePath;
  if (!workspaceId || !worktree) throw new Error(`${run.ticketKey}: missing workspace/worktree`);
  const cfg = deps.config.agents[step];

  // Capture the prior step's session id at handoff time (herdr only knows it once the
  // prior agent has reported in) so this step's prompt can point at it.
  const prevName = priorStepName(step);
  let prior = prevName ? (deps.store.getRunStep(run.id, prevName) ?? null) : null;
  if (prior && !prior.sessionId && prior.paneId) {
    const sid = await deps.herdr.agentSessionId(prior.paneId);
    if (sid) prior = deps.store.upsertRunStep(run.id, prevName!, { sessionId: sid });
  }

  renderStepPrompt(deps, run, step, prior);

  const pane = await dispatchToLayout(deps, {
    workspaceId,
    worktree,
    tab: cfg.tab,
    pane: cfg.pane,
    prompt: dispatchPrompt(step),
    paneName: `${step}:${run.ticketKey}`,
    ticketKey: run.ticketKey,
  });

  // Reset started_at on every (re)spawn so the per-step budget is measured per attempt,
  // not cumulatively across crash-recovery re-spawns.
  deps.store.upsertRunStep(run.id, step, { paneId: pane, startedAt: deps.now() });
  deps.store.updateRun(run.id, { paneId: pane }); // latest active pane (reviewing/resolver reuse it)
  deps.store.recordEvent({
    runId: run.id,
    repo: deps.config.repoName,
    ticketKey: run.ticketKey,
    type: "step_spawned",
    detail: { step, paneId: pane },
  });
  return pane;
}
