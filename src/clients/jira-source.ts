import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JiraSourceCfg } from "../config.ts";
import { bearsHerdrMarker, HERDR_MARKER, type Logger, type WorkSource, type WorkSourceSpec } from "../core/deps.ts";
import type {
  HumanAskInput,
  HumanAskResult,
  HumanPollInput,
  HumanReply,
  JiraMatchItem,
  MatchItem,
  Ticket,
  TransitionResult,
  WorkDocInfo,
  WorkState,
} from "../types.ts";
import { JiraClient, type JiraComment } from "./jira.ts";

// Attachment caps for materialize (images + videos share the count budget). Moved here from
// step.ts — they're Jira-specific (other sources have their own materialize).
const MAX_ATTACHMENTS = 12;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50 MB
const isMedia = (mime: string): boolean => mime.startsWith("image/") || mime.startsWith("video/");

const QUESTION_MARKER = `${HERDR_MARKER} question:`;

function bodyText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const rec = node as Record<string, unknown>;
  let out = typeof rec.text === "string" ? rec.text : "";
  const content = Array.isArray(rec.content) ? rec.content : [];
  for (const child of content) out += bodyText(child);
  if (rec.type === "paragraph" || rec.type === "heading") out += "\n";
  if (rec.type === "hardBreak") out += "\n";
  return out;
}

function commentText(comment: JiraComment): string {
  return bodyText(comment.body).replace(/\n{3,}/g, "\n\n").trim();
}

function humanQuestionComment(input: HumanAskInput): string {
  const step = input.step ?? "unknown";
  return [
    `${QUESTION_MARKER} ${input.repo}/${input.runId}/${input.questionId}]`,
    `Work item: ${input.key}`,
    `Step: ${step}`,
    "",
    input.question.trim(),
    "",
    "Reply in a new Jira comment. herdr-factory will resume automatically when it sees the reply.",
  ].join("\n");
}

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

  readonly spec: WorkSourceSpec = {
    statusOfRecord: "external",
    mappedStates: ["todo", "in_development", "in_review"],
    replyChannel: "comments",
    terminalAutomation: "Jira's GitHub integration owns terminal closure (merged/aborted/done are unmapped)",
  };

  async listEligible(): Promise<MatchItem[]> {
    const items = await this.jira.listEligible(this.cfg.board, this.cfg.label, this.cfg.statusTodo);
    return items.map(
      (i): JiraMatchItem => ({
        sourceType: "jira",
        key: i.key,
        summary: i.summary,
        type: i.type,
        status: i.status,
        labels: i.labels,
        fields: i.fields,
      }),
    );
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
      case "done":
        // Terminal states are unmapped for Jira: merged/aborted are owned by Jira's GitHub
        // integration, and `done` (a custom belt's terminal) has no configured Jira status — so
        // teardown stays Jira-silent (no network) regardless of which belt produced the run.
        return undefined;
    }
  }

  async transition(key: string, to: WorkState): Promise<TransitionResult> {
    const status = this.statusFor(to);
    if (!status) return { kind: "noop" }; // unmapped → no-op, and crucially NO network call (teardown parity)
    const moved = await this.jira.transition(key, status);
    return moved ? { kind: "applied" } : { kind: "noop" };
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

  async workDoc(): Promise<WorkDocInfo> {
    return { path: "ticket.json", kind: "Jira ticket (JSON)" };
  }

  async postNote(key: string, note: string): Promise<void> {
    // Marker-tagged so pollHumanReply never mistakes our own attention note for a human reply
    // (INV-6 — an unmarked note posted while a question was pending used to poison the loop).
    await this.jira.addComment(key, `${HERDR_MARKER}] ${note}`);
  }

  async askHuman(input: HumanAskInput): Promise<HumanAskResult> {
    const comment = await this.jira.addComment(input.key, humanQuestionComment(input));
    return { externalId: comment.id, externalCreatedAt: comment.created ?? null };
  }

  async pollHumanReply(input: HumanPollInput): Promise<HumanReply | null> {
    const comments = await this.jira.listComments(input.key);
    const questionIndex = comments.findIndex((c) => c.id === input.externalId);
    const cutoff = input.externalCreatedAt ? Date.parse(input.externalCreatedAt) : Number.NaN;
    const candidates = questionIndex >= 0
      ? comments.slice(questionIndex + 1)
      : Number.isFinite(cutoff)
        ? comments.filter((c) => (c.created ? Date.parse(c.created) : 0) > cutoff)
        : comments;
    for (const comment of candidates) {
      if (comment.id === input.externalId) continue;
      const text = commentText(comment);
      // Skip EVERY herdr-authored artifact — questions AND marked notes (INV-6). Blockquote-aware:
      // a human reply that quotes the question must still be accepted as a reply.
      if (bearsHerdrMarker(text)) continue;
      if (!text && !comment.body) continue;
      return {
        body: text || "(Jira comment had no extractable text.)",
        externalId: comment.id,
        externalCreatedAt: comment.created ?? null,
        author: comment.author?.displayName ?? comment.author?.accountId ?? null,
      };
    }
    return null;
  }

  async health(): Promise<void> {
    await this.jira.listEligible(this.cfg.board, this.cfg.label, this.cfg.statusTodo);
  }
}
