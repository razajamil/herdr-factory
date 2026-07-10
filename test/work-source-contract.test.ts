// The WorkSource CONTRACT suite — the charter (INV-1..11, src/core/deps.ts) as executable tests,
// parametrized over every shipped source. A new source registers a harness here; passing this
// suite is what "implements WorkSource" means behaviorally, not just structurally. Source-specific
// edge cases stay in the per-source test files; THIS file holds only the cross-source guarantees
// the reconciler relies on.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/index.ts";
import { Store } from "../src/db/store.ts";
import { JiraSource } from "../src/clients/jira-source.ts";
import { LocalMarkdownSource } from "../src/clients/local-markdown-source.ts";
import { bearsHerdrMarker, HERDR_MARKER, type WorkSource } from "../src/core/deps.ts";
import { instrumentObject } from "../src/telemetry/index.ts";
import type { WorkState } from "../src/types.ts";
import { makeFakeGithub, makeSource } from "./helpers/github-fake.ts";

const ALL_STATES: WorkState[] = ["todo", "in_development", "in_review", "merged", "aborted", "done"];

/** INV-7's safety envelope: a single unquoted shell token, a git ref segment, a URL path segment. */
const SAFE_KEY = /^[A-Za-z0-9._/#-]+$/;

/** What a harness gives the generic tests: a live source + hooks to poke its fake backend. */
interface ContractCtx {
  src: WorkSource;
  /** Create the next item in the backend, eligible (todo); returns its source-native key
   *  (harness-owned — GitHub keys are issue numbers, Jira's are PROJ-n, local_markdown's are
   *  filenames). */
  seedEligible(): string;
  /** Delete item `key` from the backend (simulates a vanished item). */
  removeItem(key: string): void;
  /** Count of ALL backend calls so far (network requests / their moral equivalent). Always 0 for
   *  a purely-local source — which makes the zero-network assertions vacuously true, as intended. */
  backendCalls(): number;
  /** comments-channel only: a HUMAN writes a comment on the item (externally authored). */
  postExternalComment?(key: string, body: string): void;
  /** A fresh memDir for materialize. */
  memDir(): string;
}

interface Harness {
  name: string;
  make(): ContractCtx;
}

const tmps: string[] = [];
afterEach(() => {
  for (const t of tmps) rmSync(t, { recursive: true, force: true });
  tmps.length = 0;
});

// --- Jira harness: an in-memory Jira behind a fetch stub (the jira-source.test.ts pattern) -----

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function jiraHarness(): ContractCtx {
  interface FakeIssue {
    status: string;
    comments: { id: string; created: string; author?: { displayName: string }; body: unknown }[];
  }
  const issues = new Map<string, FakeIssue>();
  let calls = 0;
  let commentSeq = 0;
  const adf = (text: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
  const json = (body: unknown, status = 200) =>
    ({ ok: status < 300, status, text: async () => JSON.stringify(body), headers: new Headers() }) as Response;

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls += 1;
    const u = String(url);
    const method = init?.method ?? "GET";
    const board = u.match(/\/board\/254\/issue/);
    if (board) {
      const list = [...issues.entries()]
        .filter(([, i]) => i.status === "To Do")
        .map(([key]) => ({ key, fields: { summary: `Summary of ${key}`, issuetype: { name: "Bug" }, status: { name: "To Do" }, labels: ["agent"] } }));
      return json({ issues: list });
    }
    const m = u.match(/\/rest\/api\/3\/issue\/([^/?]+)(\/(comment|transitions))?/);
    if (!m) return json({}, 404);
    const issue = issues.get(m[1]!);
    if (!issue) return json({ errorMessages: ["Issue does not exist"] }, 404);
    if (m[3] === "comment") {
      if (method === "POST") {
        const text = (JSON.parse(String(init?.body)) as { body: { content: { content: { text: string }[] }[] } }).body;
        const id = `c${++commentSeq}`;
        const created = `2026-06-28T00:0${commentSeq}:00.000+0000`;
        issue.comments.push({ id, created, body: text });
        return json({ id, created }, 201);
      }
      return json({ comments: issue.comments });
    }
    if (m[3] === "transitions") {
      if (method === "POST") {
        const id = (JSON.parse(String(init?.body)) as { transition: { id: string } }).transition.id;
        issue.status = { "1": "To Do", "2": "In development", "3": "Ready for Code Review" }[id]!;
        return json({}, 204);
      }
      return json({ transitions: [{ id: "1", to: { name: "To Do" } }, { id: "2", to: { name: "In development" } }, { id: "3", to: { name: "Ready for Code Review" } }] });
    }
    return json({ key: m[1], fields: { summary: `Summary of ${m[1]}`, status: { name: issue.status }, issuetype: { name: "Bug" }, labels: ["agent"], attachment: [] } });
  }) as typeof fetch;

  const src = new JiraSource(
    { baseUrl: "https://x.atlassian.net", project: "RWR", board: "254", statusTodo: "To Do", statusInDev: "In development", statusReview: "Ready for Code Review" },
    "me@x.com",
    "tok",
  );
  return {
    src,
    seedEligible: () => {
      const key = `RWR-${issues.size + 1}`;
      issues.set(key, { status: "To Do", comments: [] });
      return key;
    },
    removeItem: (key) => void issues.delete(key),
    backendCalls: () => calls,
    postExternalComment: (key, body) => {
      const issue = issues.get(key)!;
      const id = `c${++commentSeq}`;
      issue.comments.push({ id, created: `2026-06-28T00:0${commentSeq}:00.000+0000`, author: { displayName: "Pat" }, body: adf(body) });
    },
    memDir: () => {
      const d = mkdtempSync(join(tmpdir(), "contract-jira-"));
      tmps.push(d);
      return d;
    },
  };
}

// --- local_markdown harness: a real temp folder + in-memory store ------------------------------

function localMarkdownHarness(): ContractCtx {
  const folder = mkdtempSync(join(tmpdir(), "contract-lm-"));
  tmps.push(folder);
  const store = new Store(openDb(":memory:"), () => 1000);
  const src = new LocalMarkdownSource(folder, store, "r", "lm", () => {});
  let seq = 0;
  return {
    src,
    seedEligible: () => {
      const key = `item-${++seq}`;
      writeFileSync(join(folder, `${key}.md`), `# Summary of ${key}\n\nbody`);
      return key;
    },
    removeItem: (key) => rmSync(join(folder, `${key}.md`), { force: true }),
    backendCalls: () => 0, // purely local — zero-network invariants hold by construction
    memDir: () => {
      const d = join(folder, `.mem-${Math.random().toString(36).slice(2)}`);
      mkdirSync(d, { recursive: true });
      tmps.push(d);
      return d;
    },
  };
}

// --- github_issues harness: the in-memory REST backend from test/helpers/github-fake.ts --------

function githubIssuesHarness(): ContractCtx {
  const fake = makeFakeGithub();
  const src = makeSource(fake);
  let seq = 0;
  return {
    src,
    seedEligible: () => {
      const n = ++seq;
      fake.addIssue(n);
      return String(n);
    },
    removeItem: (key) => void fake.gone.set(Number(key), 410), // deleted (the documented status)
    backendCalls: () => fake.calls.length,
    postExternalComment: (key, body) => fake.addComment(Number(key), body, "human"),
    memDir: () => {
      const d = mkdtempSync(join(tmpdir(), "contract-gh-"));
      tmps.push(d);
      return d;
    },
  };
}

const HARNESSES: Harness[] = [
  { name: "jira", make: jiraHarness },
  { name: "local_markdown", make: localMarkdownHarness },
  { name: "github_issues", make: githubIssuesHarness },
];

// --- the charter, as tests ----------------------------------------------------------------------

describe.each(HARNESSES)("WorkSource contract: $name", ({ make }) => {
  it("spec is sane: statusOfRecord/replyChannel set, mappedStates non-empty and canonical", () => {
    const { src } = make();
    expect(["external", "internal"]).toContain(src.spec.statusOfRecord);
    expect(["comments", "file"]).toContain(src.spec.replyChannel);
    expect(src.spec.mappedStates.length).toBeGreaterThan(0);
    for (const s of src.spec.mappedStates) expect(ALL_STATES).toContain(s);
  });

  it("listEligible returns [] when the backend has nothing", async () => {
    const { src } = make();
    expect(await src.listEligible()).toEqual([]);
  });

  it("INV-12: authStatus reports a valid state with ZERO backend calls (local/cheap)", async () => {
    const ctx = make();
    const before = ctx.backendCalls();
    const st = await ctx.src.authStatus();
    expect(["ok", "unauthenticated", "not_applicable"]).toContain(st.state);
    if (st.state === "unauthenticated") expect((st.detail ?? "").trim()).not.toBe(""); // actionable
    expect(ctx.backendCalls()).toBe(before); // no network — it's a credential-presence check
  });

  it("eligible items carry non-empty key/summary/type, a safe key, and the uniform labels/fields base", async () => {
    const ctx = make();
    const key = ctx.seedEligible();
    const items = await ctx.src.listEligible();
    expect(items.length).toBe(1);
    const item = items[0]!;
    expect(item.key).toBe(key);
    expect(item.key).toMatch(SAFE_KEY); // INV-7
    expect(item.summary.trim()).not.toBe("");
    expect(item.type.trim()).not.toBe("");
    expect(Array.isArray(item.labels)).toBe(true);
    expect(typeof item.fields).toBe("object");
  });

  it("INV-3: transition to an UNMAPPED state is a noop with ZERO backend calls", async () => {
    const ctx = make();
    const key = ctx.seedEligible();
    const unmapped = ALL_STATES.filter((s) => !ctx.src.spec.mappedStates.includes(s));
    const before = ctx.backendCalls();
    for (const state of unmapped) {
      expect(await ctx.src.transition(key, state)).toEqual({ kind: "noop" });
    }
    expect(ctx.backendCalls()).toBe(before); // the load-bearing teardown-silence guarantee
  });

  it("INV-2: transition is idempotent — applied on a real move, noop on re-delivery", async () => {
    const ctx = make();
    const key = ctx.seedEligible();
    expect((await ctx.src.transition(key, "in_development")).kind).toBe("applied");
    expect((await ctx.src.transition(key, "in_development")).kind).toBe("noop"); // outbox retry
    expect((await ctx.src.transition(key, "in_review")).kind).toBe("applied");
  });

  it("INV-1: a claimed (in_development) item drops out of listEligible", async () => {
    const ctx = make();
    const first = ctx.seedEligible();
    const second = ctx.seedEligible();
    await ctx.src.transition(first, "in_development");
    expect((await ctx.src.listEligible()).map((i) => i.key)).toEqual([second]);
  });

  it("describe throws for an unknown key — and echoes the CANONICAL key for a known one (INV-11)", async () => {
    const ctx = make();
    await expect(ctx.src.describe("no-such-item")).rejects.toThrow();
    const key = ctx.seedEligible();
    expect((await ctx.src.describe(key)).key).toBe(key); // the engine dedups on what describe returns
  });

  it("INV-5: askHuman is idempotent per questionId — a lost response never double-asks the human", async () => {
    const ctx = make();
    const key = ctx.seedEligible();
    const input = { repo: "demo", runId: 7, questionId: 3, key, step: "fix", question: "Which path should win?" };
    const first = await ctx.src.askHuman(input);
    const again = await ctx.src.askHuman(input); // externalId was never persisted → re-invoked
    expect(again.externalId).toBe(first.externalId);
  });

  it("health resolves on a healthy backend", async () => {
    const { src } = make();
    await expect(src.health()).resolves.toBeUndefined();
  });

  it("INV-4: materialize is idempotent and tolerates a vanished item without throwing", async () => {
    const ctx = make();
    const key = ctx.seedEligible();
    const mem = ctx.memDir();
    await ctx.src.materialize(key, mem, () => {});
    const after = ctx.backendCalls();
    await ctx.src.materialize(key, mem, () => {}); // second run: no backend work
    expect(ctx.backendCalls()).toBe(after);
    // Vanished item: log, never throw.
    ctx.removeItem(key);
    await expect(ctx.src.materialize(key, ctx.memDir(), () => {})).resolves.toBeUndefined();
  });

  it("workDoc never throws (pre- AND post-materialize) and returns a usable relative path", async () => {
    const ctx = make();
    const key = ctx.seedEligible();
    const mem = ctx.memDir();
    const before = await ctx.src.workDoc(mem);
    expect(before.path.trim()).not.toBe("");
    expect(before.kind.trim()).not.toBe("");
    expect(before.path.startsWith("/")).toBe(false); // relative to memDir, by contract
    await ctx.src.materialize(key, mem, () => {});
    const after = await ctx.src.workDoc(mem);
    expect(after.path.trim()).not.toBe("");
  });

  it("workDoc survives the instrumentObject telemetry proxy (the sync-method-through-async-proxy trap)", async () => {
    const ctx = make();
    const wrapped = instrumentObject(ctx.src, "source");
    const wd = await wrapped.workDoc(ctx.memDir());
    // With a sync workDoc this await would yield a WorkDocInfo, but the UNAWAITED value the old
    // sync call site used was a Promise — path/kind undefined. Contract: async + awaited.
    expect(typeof wd.path).toBe("string");
    expect(typeof wd.kind).toBe("string");
  });
});

// --- comments-channel additions (INV-5/INV-6) — sources whose reply channel is a comment stream --

describe.each(HARNESSES.filter((h) => h.make().src.spec.replyChannel === "comments"))(
  "WorkSource contract (comments channel): $name",
  ({ make }) => {
    const ask = (src: WorkSource, key: string) =>
      src.askHuman({ repo: "demo", runId: 7, questionId: 3, key, step: "fix", question: "Which path should win?" });

    it("INV-5: askHuman returns a durable externalId and the posted question bears the marker", async () => {
      const ctx = make();
      const key = ctx.seedEligible();
      const res = await ask(ctx.src, key);
      expect(res.externalId.trim()).not.toBe("");
      // The question artifact itself must be skipped by the poll — proven behaviorally below.
    });

    it("INV-6: pollHumanReply skips every herdr-authored artifact (question AND marked postNote), then accepts a real reply", async () => {
      const ctx = make();
      const key = ctx.seedEligible();
      const q = await ask(ctx.src, key);
      const input = { key, questionId: 3, externalId: q.externalId, externalCreatedAt: q.externalCreatedAt };
      expect(await ctx.src.pollHumanReply(input)).toBeNull(); // only the question exists
      await ctx.src.postNote(key, "⚠ parked for attention"); // must be marker-tagged by the source
      expect(await ctx.src.pollHumanReply(input)).toBeNull(); // the note must NOT read as a reply
      ctx.postExternalComment!(key, "Use the new behavior.");
      const reply = await ctx.src.pollHumanReply(input);
      expect(reply).not.toBeNull();
      expect(reply!.body).toContain("Use the new behavior.");
    });

    it("INV-6: a quote-reply embedding the question (marker inside a blockquote) IS a reply", async () => {
      const ctx = make();
      const key = ctx.seedEligible();
      const q = await ask(ctx.src, key);
      ctx.postExternalComment!(key, `> ${HERDR_MARKER} question: demo/7/3]\nGo with option B.`);
      const reply = await ctx.src.pollHumanReply({ key, questionId: 3, externalId: q.externalId, externalCreatedAt: q.externalCreatedAt });
      expect(reply).not.toBeNull();
      expect(reply!.body).toContain("Go with option B.");
    });
  },
);

describe("bearsHerdrMarker (the INV-6 filter primitive)", () => {
  it("detects the marker outside blockquotes and ignores it inside them", () => {
    expect(bearsHerdrMarker("[herdr-factory] a note")).toBe(true);
    expect(bearsHerdrMarker("[herdr-factory question: r/1/2]\nbody")).toBe(true);
    expect(bearsHerdrMarker("plain human reply")).toBe(false);
    expect(bearsHerdrMarker("> [herdr-factory question: r/1/2]\nactual answer")).toBe(false);
    expect(bearsHerdrMarker(" > quoted marker [herdr-factory]\nreply")).toBe(false);
    expect(bearsHerdrMarker("> quoted\n[herdr-factory] but also unquoted")).toBe(true);
  });
});
