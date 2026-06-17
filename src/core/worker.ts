import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Deps } from "./deps.ts";
import type { Run } from "../types.ts";

export const CLAUDE_FLAGS = ["--dangerously-skip-permissions"];
export const WORKER_PROMPT =
  "Read .memory/herdr-cats/brief.md in this worktree and follow it exactly. This is an autonomous task — do not pause to ask for confirmation.";

const TEMPLATE_PATH = fileURLToPath(new URL("../../templates/worker-brief.md", import.meta.url));
export const CLI_PATH = fileURLToPath(new URL("../../bin/herdr-cats", import.meta.url));
const LAYOUT_WAIT_SEC = 120;
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function bootstrapText(cmd?: string): string {
  return cmd
    ? `Bootstrap the worktree: \`${cmd}\`.`
    : "Bootstrap the worktree if needed (install deps / run the repo's setup).";
}

/** Render the worker brief from the template; substitutions are literal (function
 *  replacers avoid `$`-pattern interpretation). */
export function renderBrief(deps: Deps, run: Run): string {
  const sub: Record<string, string> = {
    "@@KEY@@": run.ticketKey,
    "@@REPO@@": deps.config.repoName,
    "@@TYPE@@": run.issueType ?? "",
    "@@SUMMARY@@": run.summary ?? "",
    "@@BRANCH@@": run.branch ?? "",
    "@@WORKTREE@@": run.worktreePath ?? "",
    "@@MEMORY_DIR@@": ".memory/herdr-cats",
    "@@EVIDENCE_DIR@@": ".memory/herdr-cats/evidence",
    "@@CATS_CLI@@": CLI_PATH,
    "@@BOOTSTRAP@@": bootstrapText(deps.config.worker.bootstrapCmd),
  };
  let out = readFileSync(TEMPLATE_PATH, "utf8");
  for (const [token, value] of Object.entries(sub)) out = out.replaceAll(token, () => value);
  if (deps.config.guidance) out += `\n## Repo-specific guidance\n\n${deps.config.guidance}\n`;
  return out;
}

/** Fetch ticket + images and write the rendered brief into the worktree's .memory. */
export async function materializeBrief(deps: Deps, run: Run): Promise<void> {
  const worktree = run.worktreePath;
  if (!worktree) throw new Error(`${run.ticketKey}: no worktree path`);
  const mem = join(worktree, ".memory", "herdr-cats");
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
  writeFileSync(join(mem, "brief.md"), renderBrief(deps, run));
}

/**
 * Dispatch a claude agent the given `prompt` into the layout's `tab`/`pane`, with fallbacks:
 * send to the idle claude waiting there; else `pane run`; else spawn a dedicated pane in the
 * worktree. Renames the pane to `paneName` and returns its id. Shared by the worker and the
 * review agent so both honor the configured layout.
 */
export async function dispatchToLayout(
  deps: Deps,
  opts: { workspaceId: string; worktree: string; tab: string; pane: string; prompt: string; paneName: string; ticketKey: string },
): Promise<string> {
  let target: string | null = null;
  for (let waited = 0; waited < LAYOUT_WAIT_SEC; waited += 4) {
    target = await deps.herdr.tabPaneByLabel(opts.workspaceId, opts.tab, opts.pane);
    if (target && (await deps.herdr.paneHasClaude(target))) break;
    await deps.sleep(4000);
  }

  if (target) {
    if (await deps.herdr.paneHasClaude(target)) {
      await deps.sleep(2000); // settle so the first keystrokes aren't dropped
      await deps.herdr.agentSend(target, opts.prompt);
      await deps.herdr.paneSendKeys(target, "Enter");
      deps.log("info", `${opts.ticketKey}: dispatched to layout pane ${target} (${opts.tab}/${opts.pane})`);
    } else {
      await deps.herdr.paneRun(target, `claude ${CLAUDE_FLAGS.join(" ")} ${JSON.stringify(opts.prompt)}`);
      deps.log("info", `${opts.ticketKey}: started agent in layout pane ${target} (${opts.tab}/${opts.pane})`);
    }
  } else {
    target = await deps.herdr.agentStart({
      workspaceId: opts.workspaceId,
      cwd: opts.worktree,
      argv: ["claude", ...CLAUDE_FLAGS, opts.prompt],
      env: { HERDR_CATS_TICKET: opts.ticketKey },
    });
    if (!target) throw new Error(`${opts.ticketKey}: failed to dispatch agent to ${opts.tab}/${opts.pane}`);
    deps.log("info", `${opts.ticketKey}: agent spawned in dedicated pane ${target}`);
  }

  await deps.herdr.agentRename(target, opts.paneName);
  return target;
}

/** Dispatch the worker into the layout's main/agent pane (fallbacks: pane run; own pane). */
export async function spawnWorker(deps: Deps, run: Run): Promise<void> {
  if (run.paneId && (await deps.herdr.paneAlive(run.paneId))) {
    deps.log("info", `${run.ticketKey}: worker already running in ${run.paneId}`);
    return;
  }
  const workspaceId = run.workspaceId;
  const worktree = run.worktreePath;
  if (!workspaceId || !worktree) throw new Error(`${run.ticketKey}: missing workspace/worktree`);

  await materializeBrief(deps, run);

  const target = await dispatchToLayout(deps, {
    workspaceId,
    worktree,
    tab: deps.config.worker.mainTab,
    pane: deps.config.worker.agentPane,
    prompt: WORKER_PROMPT,
    paneName: `cat:${run.ticketKey}`,
    ticketKey: run.ticketKey,
  });

  deps.store.updateRun(run.id, { paneId: target });
  deps.store.recordEvent({
    runId: run.id,
    repo: deps.config.repoName,
    ticketKey: run.ticketKey,
    type: "worker_spawned",
    detail: { paneId: target },
  });
}
