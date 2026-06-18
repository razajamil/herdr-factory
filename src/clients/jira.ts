import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JiraIssue, Ticket } from "../types.ts";

/** Jira Cloud REST via fetch + API-token basic auth. */
export class JiraClient {
  constructor(
    private readonly baseUrl: string,
    private readonly email: string,
    private readonly token: string,
  ) {}

  requireAuth(): void {
    if (!this.email || !this.token) {
      throw new Error("Jira auth missing — set JIRA_EMAIL + JIRA_API_TOKEN in ~/.config/herdr-factory/env");
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

  /** On board `board`, status `todoStatus`, label `label`. */
  async listEligible(board: string, label: string, todoStatus: string): Promise<Ticket[]> {
    this.requireAuth();
    const jql = `status = "${todoStatus}" AND labels = "${label}" ORDER BY created ASC`;
    const data = await this.getJson<{
      issues?: { key: string; fields: { summary: string; issuetype: { name: string } } }[];
    }>(`/rest/agile/1.0/board/${board}/issue?jql=${encodeURIComponent(jql)}&fields=summary,issuetype&maxResults=50`);
    return (data.issues ?? []).map((i) => ({ key: i.key, summary: i.fields.summary, type: i.fields.issuetype.name }));
  }

  async getIssue(key: string): Promise<JiraIssue> {
    this.requireAuth();
    return this.getJson<JiraIssue>(
      `/rest/api/3/issue/${key}?fields=summary,description,issuetype,status,labels,attachment`,
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

  /** Download image attachments (image/* only, count + size capped). Returns saved filenames. */
  async downloadImages(key: string, outDir: string, max: number, maxBytes: number): Promise<string[]> {
    const issue = await this.getIssue(key);
    mkdirSync(outDir, { recursive: true });
    const images = (issue.fields.attachment ?? [])
      .filter((a) => (a.mimeType ?? "").startsWith("image/") && (a.size ?? 0) <= maxBytes)
      .slice(0, max);
    const saved: string[] = [];
    for (const a of images) {
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
