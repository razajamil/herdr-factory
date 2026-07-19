// Sentry-source behaviors NOT covered by the cross-source charter (work-source-contract.test.ts):
// the config-query poll plumbing, project-scoped polling, the stacktrace materialization, and the
// opt-in on_merge write-back (comment / resolve / none).
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db/index.ts";
import { Store } from "../src/db/store.ts";
import { SentryClient } from "../src/clients/sentry.ts";
import { SentrySource, type SentrySourceCfg } from "../src/clients/sentry-source.ts";

const realFetch = globalThis.fetch;
const tmps: string[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const t of tmps) rmSync(t, { recursive: true, force: true });
  tmps.length = 0;
});

interface Captured {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}

const DEFAULT_ISSUE = {
  id: "4823",
  shortId: "BACKEND-1AB",
  title: "TypeError: x is undefined",
  culprit: "handlers.run",
  level: "error",
  status: "unresolved",
  permalink: "https://sentry.io/organizations/acme/issues/4823/",
  count: "17",
  userCount: 4,
  metadata: { type: "TypeError", value: "x is undefined", filename: "handlers.py", function: "run" },
  project: { slug: "backend", name: "Backend" },
  platform: "python",
};

const DEFAULT_EVENT = {
  eventID: "abc",
  dateCreated: "2026-06-27T00:00:00Z",
  tags: [
    { key: "environment", value: "production" },
    { key: "release", value: "v1.2.3" },
  ],
  entries: [
    {
      type: "exception",
      data: {
        values: [
          {
            type: "TypeError",
            value: "x is undefined",
            stacktrace: {
              frames: [
                { function: "main", filename: "main.py", lineNo: 1, inApp: false },
                { function: "run", filename: "handlers.py", lineNo: 42, inApp: true },
              ],
            },
          },
        ],
      },
    },
    { type: "breadcrumbs", data: { values: [{ timestamp: "2026-06-27T00:00:00Z", category: "http", level: "info", message: "GET /x" }] } },
    { type: "request", data: { method: "POST", url: "https://api.example/x" } },
  ],
};

function fakeSentry(opts?: { issue?: Record<string, unknown>; event?: Record<string, unknown> | null }) {
  const calls: Captured[] = [];
  const notes: { id: string; dateCreated: string; data: { text: string } }[] = [];
  let noteSeq = 0;
  let clock = 0;
  const ts = () => {
    clock += 1;
    return `2026-06-28T00:00:${String(clock).padStart(2, "0")}.000Z`;
  };
  const json = (b: unknown, s = 200) => ({ ok: s < 300, status: s, text: async () => JSON.stringify(b), headers: new Headers() }) as Response;
  const issue = opts?.issue ?? DEFAULT_ISSUE;
  const event = opts?.event === undefined ? DEFAULT_EVENT : opts.event;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url: u, method, body });
    const path = new URL(u).pathname;
    // The org issues LIST endpoint omits firstRelease/lastRelease (only the DETAIL endpoint carries
    // them) — mirror that so the source's release-probe fallback is exercised faithfully.
    if (/\/issues\/$/.test(path)) {
      const { firstRelease: _f, lastRelease: _l, ...listIssue } = issue as Record<string, unknown>;
      return json([listIssue]);
    }
    if (/\/issues\/[^/]+\/events\/latest\/$/.test(path)) return event ? json(event) : json({}, 404);
    if (/\/issues\/[^/]+\/comments\/$/.test(path)) {
      if (method === "POST") {
        const note = { id: `n${++noteSeq}`, dateCreated: ts(), data: { text: String(body?.text ?? "") } };
        notes.push(note);
        return json(note, 201);
      }
      return json([...notes].reverse());
    }
    if (/\/issues\/[^/]+\/$/.test(path)) return method === "PUT" ? json({}, 200) : json(issue);
    if (/\/shortids\/[^/]+\/$/.test(path)) return json({ shortId: (issue as { shortId: string }).shortId, groupId: (issue as { id: string }).id });
    if (/\/organizations\/[^/]+\/$/.test(path)) return json({ slug: "acme" });
    const projM = path.match(/\/projects\/[^/]+\/([^/]+)\/$/); // project detail — resolveProjectIds reads .id
    if (projM) return json({ id: `pid_${projM[1]}`, slug: projM[1] });
    return json({}, 404);
  }) as typeof fetch;
  return { calls, notes };
}

function makeSource(cfgOverride?: Partial<SentrySourceCfg>, token = "sntryu_tok") {
  const store = new Store(openDb(":memory:"), () => 1000);
  const cfg: SentrySourceCfg = { baseUrl: "https://sentry.io", organization: "acme", projects: [], environment: [], query: "is:unresolved", statsPeriod: "14d", onMerge: "comment", ...cfgOverride };
  const src = new SentrySource(cfg, new SentryClient({ baseUrl: cfg.baseUrl, organization: cfg.organization, token }), store, "r", "sentry", () => {});
  return { src, store, cfg };
}

const memDir = () => {
  const d = mkdtempSync(join(tmpdir(), "sentry-src-"));
  tmps.push(d);
  return d;
};

const listCallOf = (calls: Captured[]) => calls.filter((c) => c.method === "GET" && /\/issues\/$/.test(new URL(c.url).pathname));

describe("SentrySource", () => {
  it("listEligible plumbs the config query / environment / statsPeriod into the org endpoint and maps the issue", async () => {
    const { calls } = fakeSentry();
    const { src } = makeSource({ environment: ["production", "staging"], query: "is:unresolved level:error", statsPeriod: "30d" });
    const items = await src.listEligible();
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.sourceType).toBe("sentry");
    expect(item.key).toBe("4823");
    expect(item.displayKey).toBe("BACKEND-1AB");
    expect(item.type).toBe("Bug"); // -> fix/ branch prefix
    expect(item.url).toBe("https://sentry.io/organizations/acme/issues/4823/");
    expect(item.summary).toContain("TypeError");

    const list = listCallOf(calls);
    expect(list).toHaveLength(1);
    const params = new URL(list[0]!.url).searchParams;
    expect(new URL(list[0]!.url).pathname).toBe("/api/0/organizations/acme/issues/");
    expect(params.get("query")).toBe("is:unresolved level:error");
    expect(params.getAll("environment")).toEqual(["production", "staging"]);
    expect(params.get("statsPeriod")).toBe("30d");
    expect(params.get("project")).toBe("-1"); // all accessible projects
  });

  it("with projects configured, resolves slugs to ids and polls the ORG endpoint once (so an arbitrary window works)", async () => {
    const { calls } = fakeSentry();
    const { src } = makeSource({ projects: ["backend", "web"], statsPeriod: "30d" });
    await src.listEligible();
    // Each slug is resolved to its numeric id via GET /projects/{org}/{slug}/ ...
    const resolves = calls.filter((c) => /\/projects\/[^/]+\/[^/]+\/$/.test(new URL(c.url).pathname));
    expect(resolves.map((c) => new URL(c.url).pathname)).toEqual(["/api/0/projects/acme/backend/", "/api/0/projects/acme/web/"]);
    // ... then a SINGLE org-issues call carries both project ids + the arbitrary 30d window (which the
    // project-scoped endpoint would 400 on — the whole reason we route through the org endpoint).
    const list = listCallOf(calls);
    expect(list).toHaveLength(1);
    expect(new URL(list[0]!.url).pathname).toBe("/api/0/organizations/acme/issues/");
    const params = new URL(list[0]!.url).searchParams;
    expect(params.getAll("project")).toEqual(["pid_backend", "pid_web"]);
    expect(params.get("statsPeriod")).toBe("30d");
  });

  it("a bad project slug (404) is skipped, not fatal, so other projects still poll", async () => {
    // Fake that 404s the 'ghost' project detail but resolves 'backend'.
    const json = (b: unknown, s = 200) => ({ ok: s < 300, status: s, text: async () => JSON.stringify(b), headers: new Headers() }) as Response;
    globalThis.fetch = (async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      if (/\/issues\/$/.test(path)) return json([DEFAULT_ISSUE]);
      const m = path.match(/\/projects\/[^/]+\/([^/]+)\/$/);
      if (m) return m[1] === "ghost" ? json({}, 404) : json({ id: `pid_${m[1]}`, slug: m[1] });
      return json({}, 404);
    }) as typeof fetch;
    const { src } = makeSource({ projects: ["ghost", "backend"] });
    const items = await src.listEligible();
    expect(items).toHaveLength(1); // the poll succeeded (ghost skipped), backend surfaced work
  });

  it("materialize renders the exception, stacktrace, breadcrumbs and request into task.md (+ raw issue.json)", async () => {
    fakeSentry();
    const { src } = makeSource({ environment: ["production"] });
    const mem = memDir();
    await src.materialize("4823", mem, () => {});
    const task = readFileSync(join(mem, "task.md"), "utf8");
    expect(task).toContain("Sentry issue BACKEND-1AB");
    expect(task).toContain("TypeError: x is undefined");
    expect(task).toContain("handlers.py:42"); // the in-app frame
    expect(task).toContain("<- in-app");
    expect(task).toContain("main.py:1"); // the system frame is kept too
    expect(task).toContain("Breadcrumbs");
    expect(task).toContain("GET /x");
    expect(task).toContain("### Request");
    expect(task).toContain("POST https://api.example/x");
    expect(task).toContain("Environment: production");
    expect(task).toContain("Release: v1.2.3");

    const raw = JSON.parse(readFileSync(join(mem, "issue.json"), "utf8"));
    expect(raw.issue.id).toBe("4823");
    expect(raw.event.eventID).toBe("abc");
  });

  it("materialize degrades gracefully when the latest event is missing (issue only)", async () => {
    fakeSentry({ event: null });
    const { src } = makeSource();
    const mem = memDir();
    await src.materialize("4823", mem, () => {});
    const task = readFileSync(join(mem, "task.md"), "utf8");
    expect(task).toContain("Sentry issue BACKEND-1AB");
    expect(task).toContain("No event payload was available");
  });

  it("transition to in_development is a LOCAL ledger write — zero Sentry calls", async () => {
    const { calls } = fakeSentry();
    const { src, store } = makeSource();
    const before = calls.length;
    expect((await src.transition("4823", "in_development")).kind).toBe("applied");
    expect(calls.length).toBe(before); // internal ledger — no network
    expect(store.getWorkItem("r", "sentry", "4823")?.status).toBe("in_development");
  });

  it("on_merge=comment posts a marker-tagged PR-link note, idempotently, and moves the internal ledger", async () => {
    const { calls } = fakeSentry();
    const { src, store } = makeSource({ onMerge: "comment" });
    const ctx = { prNumber: 42, prUrl: "https://github.com/acme/app/pull/42" };
    expect((await src.transition("4823", "merged", undefined, ctx)).kind).toBe("applied");
    expect(store.getWorkItem("r", "sentry", "4823")?.status).toBe("merged");

    const posts = calls.filter((c) => c.method === "POST" && /\/comments\/$/.test(new URL(c.url).pathname));
    expect(posts).toHaveLength(1);
    expect(String(posts[0]!.body!.text)).toContain("[herdr-factory] Fixed by https://github.com/acme/app/pull/42");

    // A retried `merged` intent must not double-post (idempotency scan).
    await src.transition("4823", "merged", undefined, ctx);
    expect(calls.filter((c) => c.method === "POST").length).toBe(1);
  });

  it("on_merge=comment degrades to a generic note when the PR context is absent (retried intent, ended run)", async () => {
    const { calls } = fakeSentry();
    const { src } = makeSource({ onMerge: "comment" });
    await src.transition("4823", "merged"); // no ctx
    const post = calls.find((c) => c.method === "POST" && /\/comments\/$/.test(new URL(c.url).pathname));
    expect(String(post!.body!.text)).toContain("[herdr-factory] Fixed by a merged pull request");
  });

  it("on_merge=resolve / resolve_in_next_release PUT the issue status; on_merge=none writes nothing", async () => {
    {
      const { calls } = fakeSentry();
      const { src } = makeSource({ onMerge: "resolve" });
      await src.transition("4823", "merged", undefined, { prNumber: 1 });
      const put = calls.find((c) => c.method === "PUT");
      expect(put?.body?.status).toBe("resolved");
    }
    {
      const { calls } = fakeSentry();
      const { src } = makeSource({ onMerge: "resolve_in_next_release" });
      await src.transition("4823", "merged", undefined, { prNumber: 1 });
      expect(calls.find((c) => c.method === "PUT")?.body?.status).toBe("resolvedInNextRelease");
    }
    {
      const { calls } = fakeSentry();
      const { src } = makeSource({ onMerge: "none" });
      await src.transition("4823", "merged", undefined, { prNumber: 1 });
      expect(calls.filter((c) => c.method === "PUT" || c.method === "POST")).toHaveLength(0);
    }
  });

  it("a Sentry on_merge failure never wedges the transition (best-effort write-back)", async () => {
    // Backend that rejects the comment POST with a 500.
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push(method);
      const path = new URL(String(url)).pathname;
      if (/\/comments\/$/.test(path) && method === "POST") return { ok: false, status: 500, text: async () => "boom", headers: new Headers() } as Response;
      if (/\/comments\/$/.test(path)) return { ok: true, status: 200, text: async () => "[]", headers: new Headers() } as Response;
      return { ok: true, status: 200, text: async () => "{}", headers: new Headers() } as Response;
    }) as typeof fetch;
    const { src, store } = makeSource({ onMerge: "comment" });
    // The ledger transition must still succeed (the load-bearing part).
    expect((await src.transition("4823", "merged", undefined, { prNumber: 1, prUrl: "u" })).kind).toBe("applied");
    expect(store.getWorkItem("r", "sentry", "4823")?.status).toBe("merged");
  });

  it("materialize records the release the issue was last seen on (into the internal ledger)", async () => {
    fakeSentry({ issue: { ...DEFAULT_ISSUE, lastRelease: { version: "v1.2.3" } } });
    const { src, store } = makeSource();
    store.setWorkItemStatus("r", "sentry", "4823", "in_development"); // the claim already created the row
    await src.materialize("4823", memDir(), () => {});
    expect(store.getWorkItem("r", "sentry", "4823")?.lastRelease).toBe("v1.2.3");
    expect(store.getWorkItem("r", "sentry", "4823")?.status).toBe("in_development"); // status untouched
  });

  it("a merged issue that recurs on a DIFFERENT release is reopened (ledger reset to todo, not deleted)", async () => {
    // Sentry flags a regression; the list omits the release, so the source spends one detail fetch.
    const { calls } = fakeSentry({ issue: { ...DEFAULT_ISSUE, substatus: "regressed", lastRelease: { version: "v2.0.0" } } });
    const { src, store } = makeSource();
    const before = store.getWorkItem("r", "sentry", "4823");
    store.setWorkItemStatus("r", "sentry", "4823", "merged", { lastRelease: "v1.2.3" });
    const rowId = store.getWorkItem("r", "sentry", "4823")!.id;

    const items = await src.listEligible();
    expect(items.map((i) => i.key)).toEqual(["4823"]); // re-admitted as eligible
    const wi = store.getWorkItem("r", "sentry", "4823")!;
    expect(wi.status).toBe("todo"); // reset, not suppressed
    expect(wi.id).toBe(rowId); // same row (updated, not deleted) — the resilient choice
    expect(wi.lastRelease).toBe("v2.0.0"); // baseline advanced to the new release
    expect(before).toBeUndefined();
    // Confirms the bounded detail probe fired (list omits the release).
    expect(calls.some((c) => c.method === "GET" && /\/issues\/4823\/$/.test(new URL(c.url).pathname))).toBe(true);
  });

  it("a merged issue still on the SAME release stays suppressed (no reopen, no spurious eligibility)", async () => {
    fakeSentry({ issue: { ...DEFAULT_ISSUE, substatus: "regressed", lastRelease: { version: "v1.2.3" } } });
    const { src, store } = makeSource();
    store.setWorkItemStatus("r", "sentry", "4823", "merged", { lastRelease: "v1.2.3" });
    expect(await src.listEligible()).toHaveLength(0);
    expect(store.getWorkItem("r", "sentry", "4823")?.status).toBe("merged");
  });

  it("a regressed merged issue with no recorded release baseline is reopened (trusting Sentry's flag)", async () => {
    fakeSentry({ issue: { ...DEFAULT_ISSUE, substatus: "regressed" } }); // no lastRelease anywhere
    const { src, store } = makeSource();
    store.setWorkItemStatus("r", "sentry", "4823", "merged"); // no release recorded
    const items = await src.listEligible();
    expect(items.map((i) => i.key)).toEqual(["4823"]);
    expect(store.getWorkItem("r", "sentry", "4823")?.status).toBe("todo");
  });

  it("an in_development / aborted issue is never yanked back to eligible by a release change", async () => {
    for (const state of ["in_development", "aborted"] as const) {
      fakeSentry({ issue: { ...DEFAULT_ISSUE, substatus: "regressed", lastRelease: { version: "v9.9.9" } } });
      const { src, store } = makeSource();
      store.setWorkItemStatus("r", "sentry", "4823", state, { lastRelease: "v1.2.3" });
      expect(await src.listEligible()).toHaveLength(0);
      expect(store.getWorkItem("r", "sentry", "4823")?.status).toBe(state);
    }
  });

  it("describe accepts a shortId OR a numeric id, echoing the canonical numeric key (INV-11)", async () => {
    fakeSentry();
    const { src } = makeSource();
    const byShort = await src.describe("BACKEND-1AB");
    expect(byShort.key).toBe("4823");
    expect(byShort.displayKey).toBe("BACKEND-1AB");
    const byId = await src.describe("4823");
    expect(byId.key).toBe("4823");
  });

  it("authStatus is a zero-network credential-presence check", async () => {
    const { calls } = fakeSentry();
    expect((await makeSource({}, "sntryu_tok").src.authStatus()).state).toBe("ok");
    const st = await makeSource({}, "").src.authStatus();
    expect(st.state).toBe("unauthenticated");
    expect((st.detail ?? "").trim()).not.toBe("");
    expect(calls.length).toBe(0); // authStatus never hits the backend
  });

  it("a rejected token surfaces as a typed SourceUnauthenticatedError (auto-pauses the source)", async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 403, text: async () => "forbidden", headers: new Headers() }) as Response) as typeof fetch;
    const { src } = makeSource();
    await expect(src.listEligible()).rejects.toMatchObject({ name: "SourceUnauthenticatedError", reason: "rejected" });
  });
});
