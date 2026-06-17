import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Deps } from "./deps.ts";
import type { Run } from "../types.ts";

export const CLAUDE_FLAGS = ["--dangerously-skip-permissions"];
export const WORKER_PROMPT =
  "Read .memory/herdr-cats/brief.md in this worktree and follow it exactly. This is an autonomous task — do not pause to ask for confirmation.";

const TEMPLATE_PATH = fileURLToPath(new URL("../../templates/worker-brief.md", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../../bin/herdr-cats.mjs", import.meta.url));
const LAYOUT_WAIT_SEC = 120;
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function bootstrapText(cmd?: string): string {
  return cmd
    ? `Bootstrap the worktree: \`${cmd}\`.`
    : "Bootstrap the worktree if needed (install deps / run the repo's setup).";
}
function deslopText(cmd?: string): string {
  return cmd
    ? `Run \`${cmd}\` over your changes and apply its cleanups.`
    : "Review your own diff and remove unnecessary complexity / AI slop before pushing.";
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
    "@@DESLOP@@": deslopText(deps.config.worker.deslopCmd),
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

  let target: string | null = null;
  for (let waited = 0; waited < LAYOUT_WAIT_SEC; waited += 4) {
    target = await deps.herdr.tabPaneByLabel(workspaceId, deps.config.layout.mainTab, deps.config.layout.agentPane);
    if (target && (await deps.herdr.paneHasClaude(target))) break;
    await deps.sleep(4000);
  }

  if (target) {
    if (await deps.herdr.paneHasClaude(target)) {
      await deps.sleep(2000); // settle so the first keystrokes aren't dropped
      await deps.herdr.agentSend(target, WORKER_PROMPT);
      await deps.herdr.paneSendKeys(target, "Enter");
      deps.log("info", `${run.ticketKey}: dispatched brief to layout agent pane ${target}`);
    } else {
      await deps.herdr.paneRun(target, `claude ${CLAUDE_FLAGS.join(" ")} ${JSON.stringify(WORKER_PROMPT)}`);
      deps.log("info", `${run.ticketKey}: started worker in layout agent pane ${target}`);
    }
  } else {
    target = await deps.herdr.agentStart({
      workspaceId,
      cwd: worktree,
      argv: ["claude", ...CLAUDE_FLAGS, WORKER_PROMPT],
      env: { HERDR_CATS_TICKET: run.ticketKey },
    });
    if (!target) throw new Error(`${run.ticketKey}: failed to spawn worker`);
    deps.log("info", `${run.ticketKey}: worker spawned in dedicated pane ${target}`);
  }

  deps.store.updateRun(run.id, { paneId: target });
  await deps.herdr.agentRename(target, `cat:${run.ticketKey}`);
  deps.store.recordEvent({
    runId: run.id,
    repo: deps.config.repoName,
    ticketKey: run.ticketKey,
    type: "worker_spawned",
    detail: { paneId: target },
  });
}
