import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JiraIssue } from "../types.ts";
import { SourceUnauthenticatedError } from "../auth/errors.ts";
import { HttpStatusError, httpOk, httpOkBytes, TokenBucket, type HttpPolicy, type HttpRequest, type HttpResponse } from "./http.ts";

/** Map a Jira 401/403 to the typed auth error (else pass the error through unchanged). Jira uses
 *  Basic auth, so a 401/403 is unambiguously bad/expired credentials — not a scope/permission
 *  nuance like GitHub's 403. */
function asJiraAuthError(e: unknown): unknown {
  if (e instanceof HttpStatusError && (e.status === 401 || e.status === 403)) {
    return new SourceUnauthenticatedError({
      reason: "rejected",
      hint: "Jira rejected the credentials (HTTP " + e.status + ") — check JIRA_EMAIL + JIRA_API_TOKEN in the repo env",
      cause: e,
    });
  }
  return e;
}

/** Time budget for a JSON API round-trip; media downloads get a larger one. Both are HARD
 *  bounds — a black-holed Jira connection must never wedge a reconcile tick. */
const JIRA_TIMEOUT_MS = 30_000;
const JIRA_MEDIA_TIMEOUT_MS = 120_000;

// Client-side ceiling on our Jira load: 5 req/s sustained with a burst of 10, shared by every
// call this client makes (a claim burst is ~5 calls per ticket; parked runs poll comments). Jira
// Cloud's per-user budget is comfortably above this — the point is to smooth OUR spikes so we
// never trip 429s in the first place; the retry policy (Retry-After-aware) handles the rest.
const JIRA_RATE_PER_SEC = 5;
const JIRA_BURST = 10;

/** A board-search result with the fields a belt's match predicate routes on. `fields` is the raw
 *  Jira issue.fields object (summary/issuetype/status/labels) fetched by the board query. */
export interface JiraEligible {
  key: string;
  summary: string;
  type: string;
  status: string;
  labels: string[];
  fields: Record<string, unknown>;
}

export interface JiraComment {
  id: string;
  created?: string;
  updated?: string;
  author?: { displayName?: string; accountId?: string };
  body?: unknown;
}

function adfDoc(text: string): unknown {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return {
    type: "doc",
    version: 1,
    content: lines.map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    })),
  };
}

/** Jira Cloud REST via fetch + API-token basic auth. All calls share one token bucket and a
 *  Retry-After-honoring retry policy (see clients/http.ts). */
export class JiraClient {
  private readonly baseUrl: string;
  private readonly email: string;
  private readonly token: string;
  private readonly bucket = new TokenBucket(JIRA_RATE_PER_SEC, JIRA_BURST);
  constructor(baseUrl: string, email: string, token: string) {
    this.baseUrl = baseUrl;
    this.email = email;
    this.token = token;
  }

  requireAuth(): void {
    if (!this.email || !this.token) {
      throw new SourceUnauthenticatedError({
        reason: "missing",
        hint: "Jira auth missing — set JIRA_EMAIL + JIRA_API_TOKEN in the repo's env (~/.config/herdr-factory/repos/<name>/env)",
      });
    }
  }

  /** httpOk with Jira's 401/403 mapped to the typed auth error. All JSON round-trips go through
   *  here so a rejected credential surfaces as SourceUnauthenticatedError everywhere, not a raw
   *  HttpStatusError. (Attachment downloads stay on raw httpOkBytes — they're best-effort and
   *  swallow their own errors, so an auth failure there is a skipped attachment, not a poison.) */
  private async okOrAuth(req: HttpRequest, policy: HttpPolicy): Promise<HttpResponse> {
    try {
      return await httpOk(req, policy);
    } catch (e) {
      throw asJiraAuthError(e);
    }
  }

  private headers(): Record<string, string> {
    return {
      Authorization: "Basic " + Buffer.from(`${this.email}:${this.token}`).toString("base64"),
      Accept: "application/json",
    };
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.okOrAuth({ url: this.baseUrl + path, headers: this.headers(), timeoutMs: JIRA_TIMEOUT_MS }, { bucket: this.bucket });
    return JSON.parse(res.text) as T;
  }

  // POST retries are bounded to 1: a 429 was definitively not processed (safe), but a timed-out
  // or 5xx write may have landed — a rare duplicate comment is acceptable noise, a retry storm
  // of writes is not.
  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await this.okOrAuth(
      {
        url: this.baseUrl + path,
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs: JIRA_TIMEOUT_MS,
      },
      { bucket: this.bucket, retries: 1 },
    );
    return JSON.parse(res.text) as T;
  }

  /** On board `board`, status `todoStatus`, and (when given) label `label` — the belt's pickup
   *  label, filtered server-side. Returns each issue's routing fields (status/labels + the raw
   *  fields object) so a belt's match predicate can route at claim time. `label` is omitted only by
   *  the doctor's connectivity probe; the real belt flow always passes one. */
  async listEligible(board: string, label: string | undefined, todoStatus: string): Promise<JiraEligible[]> {
    this.requireAuth();
    const labelClause = label ? ` AND labels = "${label}"` : "";
    const jql = `status = "${todoStatus}"${labelClause} ORDER BY created ASC`;
    const data = await this.getJson<{
      issues?: {
        key: string;
        fields: { summary: string; issuetype: { name: string }; status?: { name: string }; labels?: string[] };
      }[];
    }>(`/rest/agile/1.0/board/${board}/issue?jql=${encodeURIComponent(jql)}&fields=summary,issuetype,status,labels&maxResults=50`);
    return (data.issues ?? []).map((i) => ({
      key: i.key,
      summary: i.fields.summary,
      type: i.fields.issuetype.name,
      status: i.fields.status?.name ?? todoStatus,
      labels: i.fields.labels ?? [],
      fields: i.fields as Record<string, unknown>,
    }));
  }

  async getIssue(key: string): Promise<JiraIssue> {
    this.requireAuth();
    return this.getJson<JiraIssue>(
      `/rest/api/3/issue/${key}?fields=summary,description,issuetype,status,labels,attachment,comment`,
    );
  }

  async currentStatus(key: string): Promise<string> {
    return (await this.getIssue(key)).fields.status?.name ?? "";
  }

  async addComment(key: string, text: string): Promise<JiraComment> {
    this.requireAuth();
    return this.postJson<JiraComment>(`/rest/api/3/issue/${key}/comment`, { body: adfDoc(text) });
  }

  async listComments(key: string): Promise<JiraComment[]> {
    this.requireAuth();
    const data = await this.getJson<{ comments?: JiraComment[] }>(
      `/rest/api/3/issue/${key}/comment?orderBy=created&maxResults=100`,
    );
    return data.comments ?? [];
  }

  /** Idempotent, case-insensitive transition. Returns false if already in target. */
  async transition(key: string, targetName: string): Promise<boolean> {
    this.requireAuth();
    const current = await this.currentStatus(key);
    if (current.toLowerCase() === targetName.toLowerCase()) return false;
    const tr = await this.getJson<{ transitions?: { id: string; to?: { name?: string } }[] }>(
      `/rest/api/3/issue/${key}/transitions`,
    );
    const match = (tr.transitions ?? []).find((t) => t.to?.name?.toLowerCase() === targetName.toLowerCase());
    if (!match) throw new Error(`${key}: no transition from "${current}" to "${targetName}"`);
    // The transition POST returns 204 with an empty body — okOrAuth (not postJson, which parses).
    await this.okOrAuth(
      {
        url: `${this.baseUrl}/rest/api/3/issue/${key}/transitions`,
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ transition: { id: match.id } }),
        timeoutMs: JIRA_TIMEOUT_MS,
      },
      { bucket: this.bucket, retries: 1 },
    );
    return true;
  }

  /**
   * Download image + video attachments (image/* and video/*, count + per-type size
   * capped). Returns saved filenames. Other mime types (PDFs, logs, …) are skipped.
   */
  async downloadAttachments(
    key: string,
    outDir: string,
    max: number,
    maxImageBytes: number,
    maxVideoBytes: number,
  ): Promise<string[]> {
    const issue = await this.getIssue(key);
    mkdirSync(outDir, { recursive: true });
    const media = (issue.fields.attachment ?? [])
      .filter((a) => {
        const mime = a.mimeType ?? "";
        const size = a.size ?? 0;
        return (
          (mime.startsWith("image/") && size <= maxImageBytes) ||
          (mime.startsWith("video/") && size <= maxVideoBytes)
        );
      })
      .slice(0, max);
    const saved: string[] = [];
    for (const a of media) {
      let buf: Buffer;
      try {
        buf = (
          await httpOkBytes(
            { url: a.content, headers: this.headers(), timeoutMs: JIRA_MEDIA_TIMEOUT_MS },
            { bucket: this.bucket, retries: 1 },
          )
        ).bytes;
      } catch {
        continue; // one bad attachment (4xx/timeout) shouldn't sink the rest
      }
      const safe = a.filename.replace(/[^A-Za-z0-9._-]/g, "_");
      writeFileSync(join(outDir, safe), buf);
      saved.push(safe);
    }
    return saved;
  }
}
