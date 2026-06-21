import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JiraSourceCfg } from "../config.ts";
import type { Logger, WorkSource } from "../core/deps.ts";
import type { Ticket, WorkState } from "../types.ts";
import { JiraClient } from "./jira.ts";

// Attachment caps for materialize (images + videos share the count budget). Moved here from
// step.ts — they're Jira-specific (other sources have their own materialize).
const MAX_ATTACHMENTS = 12;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50 MB
const isMedia = (mime: string): boolean => mime.startsWith("image/") || mime.startsWith("video/");

/**
 * The Jira work source: a thin adapter over JiraClient that maps the canonical WorkState
 * lifecycle onto configured Jira statuses. `merged`/`aborted` are deliberately UNMAPPED —
 * Jira's terminal state is owned by its GitHub integration — and `transition` short-circuits
 * to a no-op with NO network call for them, so teardown stays Jira-silent exactly as before.
 */
export class JiraSource implements WorkSource {
  private readonly jira: JiraClient;
  private readonly cfg: JiraSourceCfg;
  constructor(cfg: JiraSourceCfg, email: string, token: string) {
    this.cfg = cfg;
    this.jira = new JiraClient(cfg.baseUrl, email, token);
  }

  listEligible(): Promise<Ticket[]> {
    return this.jira.listEligible(this.cfg.board, this.cfg.label, this.cfg.statusTodo);
  }

  async describe(key: string): Promise<Ticket> {
    const issue = await this.jira.getIssue(key);
    return { key: issue.key, summary: issue.fields.summary, type: issue.fields.issuetype?.name ?? "Task" };
  }

  /** Canonical state → configured Jira status name; undefined when unmapped (no transition). */
  private statusFor(to: WorkState): string | undefined {
    switch (to) {
      case "todo":
        return this.cfg.statusTodo;
      case "in_development":
        return this.cfg.statusInDev;
      case "in_review":
        return this.cfg.statusReview;
      case "merged":
      case "aborted":
        return undefined; // owned by Jira's GitHub integration — never written here
    }
  }

  async transition(key: string, to: WorkState): Promise<boolean> {
    const status = this.statusFor(to);
    if (!status) return false; // unmapped → no-op, and crucially NO network call (teardown parity)
    return this.jira.transition(key, status);
  }

  async materialize(key: string, memDir: string, log: Logger): Promise<void> {
    if (existsSync(join(memDir, "ticket.json"))) return; // idempotent across claiming ticks
    mkdirSync(join(memDir, "attachments"), { recursive: true });
    let mediaCount = 0;
    try {
      const issue = await this.jira.getIssue(key);
      writeFileSync(join(memDir, "ticket.json"), JSON.stringify(issue, null, 2));
      mediaCount = (issue.fields.attachment ?? []).filter((a) => isMedia(a.mimeType ?? "")).length;
    } catch {
      log("warn", `${key}: could not save ticket.json`);
    }
    try {
      const saved = await this.jira.downloadAttachments(
        key,
        join(memDir, "attachments"),
        MAX_ATTACHMENTS,
        MAX_IMAGE_BYTES,
        MAX_VIDEO_BYTES,
      );
      // Don't silently swallow truncation — the fix agent is told to study every attachment.
      if (mediaCount > saved.length) {
        log(
          "warn",
          `${key}: saved ${saved.length}/${mediaCount} media attachments — rest skipped (over the ${MAX_ATTACHMENTS} cap or size limit)`,
        );
      }
    } catch {
      log("warn", `${key}: attachment download had issues`);
    }
  }

  async health(): Promise<void> {
    await this.jira.listEligible(this.cfg.board, this.cfg.label, this.cfg.statusTodo);
  }
}
