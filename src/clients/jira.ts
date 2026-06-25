import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JiraIssue } from "../types.ts";

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

/** Jira Cloud REST via fetch + API-token basic auth. */
export class JiraClient {
  private readonly baseUrl: string;
  private readonly email: string;
  private readonly token: string;
  constructor(baseUrl: string, email: string, token: string) {
    this.baseUrl = baseUrl;
    this.email = email;
    this.token = token;
  }

  requireAuth(): void {
    if (!this.email || !this.token) {
      throw new Error(
        "Jira auth missing — set JIRA_EMAIL + JIRA_API_TOKEN in the repo's env (~/.config/herdr-factory/repos/<name>/env) or the shared ~/.config/herdr-factory/env",
      );
    }
  }

  private headers(): Record<string, string> {
    return {
      Authorization: "Basic " + Buffer.from(`${this.email}:${this.token}`).toString("base64"),
      Accept: "application/json",
    };
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await fetch(this.baseUrl + path, { headers: this.headers() });
    if (!res.ok) throw new Error(`Jira GET ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  /** On board `board`, status `todoStatus`, label `label`. Returns each issue's routing fields
   *  (status/labels + the raw fields object) so a belt's match predicate can route at claim time. */
  async listEligible(board: string, label: string, todoStatus: string): Promise<JiraEligible[]> {
    this.requireAuth();
    const jql = `status = "${todoStatus}" AND labels = "${label}" ORDER BY created ASC`;
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
    const res = await fetch(`${this.baseUrl}/rest/api/3/issue/${key}/transitions`, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ transition: { id: match.id } }),
    });
    if (!res.ok) throw new Error(`Jira transition ${key} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
      const res = await fetch(a.content, { headers: this.headers(), redirect: "follow" });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const safe = a.filename.replace(/[^A-Za-z0-9._-]/g, "_");
      writeFileSync(join(outDir, safe), buf);
      saved.push(safe);
    }
    return saved;
  }
}
