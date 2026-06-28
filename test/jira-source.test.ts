import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JiraSource } from "../src/clients/jira-source.ts";
import type { JiraSourceCfg } from "../src/config.ts";

const CFG: JiraSourceCfg = {
  baseUrl: "https://x.atlassian.net",
  project: "RWR",
  board: "254",
  label: "agent",
  statusTodo: "To Do",
  statusInDev: "In development",
  statusReview: "Ready for Code Review",
};

const tmps: string[] = [];
let fetchCalls: { url: string; method: string }[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
  // Stub fetch: every GET returns an issue already in "In development" (so a mapped transition
  // is a case-insensitive no-op after a single getIssue call); attachments are empty.
  globalThis.fetch = (async (url: string | URL, init?: { method?: string }) => {
    fetchCalls.push({ url: String(url), method: init?.method ?? "GET" });
    const body = { key: "RWR-1", fields: { summary: "s", status: { name: "In development" }, issuetype: { name: "Bug" }, attachment: [] } };
    return { ok: true, status: 200, json: async () => body, text: async () => "" } as Response;
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const t of tmps) rmSync(t, { recursive: true, force: true });
  tmps.length = 0;
});

describe("JiraSource", () => {
  const src = () => new JiraSource(CFG, "me@x.com", "tok");

  // The single most load-bearing parity guarantee: unmapped canonical states (merged/aborted) —
  // which teardown writes for every run — must NOT touch the network, so teardown stays
  // Jira-silent exactly as it was before multi-source.
  it("transition(merged) and transition(aborted) make ZERO fetch calls and return false", async () => {
    expect(await src().transition("RWR-1", "merged")).toBe(false);
    expect(await src().transition("RWR-1", "aborted")).toBe(false);
    expect(fetchCalls.length).toBe(0);
  });

  it("transition(in_development) maps to the configured status and DOES hit the network", async () => {
    const moved = await src().transition("RWR-1", "in_development");
    expect(moved).toBe(false); // already there (case-insensitive) → no POST, but it queried
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    expect(fetchCalls[0]!.url).toContain("/rest/api/3/issue/RWR-1");
  });

  it("transition(in_review) maps to the configured status and POSTs when the status differs", async () => {
    // Issue currently "In development"; target maps to "Ready for Code Review" → a real move.
    globalThis.fetch = (async (url: string | URL, init?: { method?: string }) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      fetchCalls.push({ url: u, method });
      if (u.includes("/transitions") && method === "GET") {
        return { ok: true, status: 200, json: async () => ({ transitions: [{ id: "42", to: { name: "Ready for Code Review" } }] }), text: async () => "" } as Response;
      }
      const body = { key: "RWR-1", fields: { summary: "s", status: { name: "In development" }, issuetype: { name: "Bug" }, attachment: [] } };
      return { ok: true, status: 200, json: async () => body, text: async () => "" } as Response;
    }) as typeof fetch;
    const moved = await src().transition("RWR-1", "in_review");
    expect(moved).toBe(true);
    expect(fetchCalls.some((c) => c.method === "POST" && c.url.includes("/transitions"))).toBe(true);
  });

  it("describe maps a Jira issue to a Ticket", async () => {
    const t = await src().describe("RWR-1");
    expect(t).toEqual({ key: "RWR-1", summary: "s", type: "Bug" });
  });

  it("listEligible returns the jira match item (status + labels + raw fields)", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/board/254/issue")) {
        const issues = [{ key: "RWR-9", fields: { summary: "Crash on save", issuetype: { name: "Bug" }, status: { name: "To Do" }, labels: ["agent", "p1"] } }];
        return { ok: true, status: 200, json: async () => ({ issues }), text: async () => "" } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" } as Response;
    }) as typeof fetch;
    const items = await src().listEligible();
    expect(items.length).toBe(1);
    expect(items[0]!).toMatchObject({ sourceType: "jira", key: "RWR-9", summary: "Crash on save", type: "Bug", status: "To Do", labels: ["agent", "p1"] });
  });

  it("materialize writes ticket.json (idempotent)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jira-mat-"));
    tmps.push(dir);
    await src().materialize("RWR-1", dir, () => {});
    expect(existsSync(join(dir, "ticket.json"))).toBe(true);
    const after = fetchCalls.length;
    await src().materialize("RWR-1", dir, () => {}); // idempotent: ticket.json exists → no work
    expect(fetchCalls.length).toBe(after);
  });

  it("askHuman posts a marked Jira comment", async () => {
    let posted = "";
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), method: init?.method ?? "GET" });
      posted = String(init?.body ?? "");
      return { ok: true, status: 201, json: async () => ({ id: "10000", created: "2026-06-28T00:00:00.000+0000" }), text: async () => "" } as Response;
    }) as typeof fetch;

    const res = await src().askHuman({ repo: "demo", runId: 7, questionId: 3, key: "RWR-1", step: "fix", question: "Which path should win?" });

    expect(res.externalId).toBe("10000");
    expect(fetchCalls).toEqual([{ url: "https://x.atlassian.net/rest/api/3/issue/RWR-1/comment", method: "POST" }]);
    expect(posted).toContain("herdr-factory question: demo/7/3");
    expect(posted).toContain("Which path should win?");
  });

  it("pollHumanReply returns the first later non-question Jira comment", async () => {
    const adf = (text: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), method: init?.method ?? "GET" });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          comments: [
            { id: "q1", created: "2026-06-28T00:00:00.000+0000", body: adf("[herdr-factory question: demo/7/3]") },
            { id: "a1", created: "2026-06-28T00:01:00.000+0000", author: { displayName: "Pat" }, body: adf("Use the new behavior.") },
          ],
        }),
        text: async () => "",
      } as Response;
    }) as typeof fetch;

    const reply = await src().pollHumanReply({ key: "RWR-1", questionId: 3, externalId: "q1", externalCreatedAt: "2026-06-28T00:00:00.000+0000" });

    expect(reply).toMatchObject({ body: "Use the new behavior.", externalId: "a1", author: "Pat" });
  });
});
