import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFakeGithub, makeSource, type FakeGithub } from "./helpers/github-fake.ts";
import { isGithubIssuesItem, StaleItemError } from "../src/types.ts";

let fake: FakeGithub | undefined;
const tmps: string[] = [];
afterEach(() => {
  fake?.restore();
  fake = undefined;
  for (const t of tmps) rmSync(t, { recursive: true, force: true });
  tmps.length = 0;
});

const mem = () => {
  const d = mkdtempSync(join(tmpdir(), "gh-mat-"));
  tmps.push(d);
  return d;
};

describe("GithubIssuesSource — eligibility", () => {
  it("lists open trigger-labeled issues oldest-first as rich match items", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7, { title: "Crash on save", labels: ["herdr", "bug"], assignees: [{ login: "pat" }] });
    fake.addIssue(3, { title: "Older first", labels: ["herdr"] });
    fake.addIssue(9, { title: "No trigger", labels: ["bug"] }); // not trigger-labeled
    const items = await makeSource(fake).listEligible();
    expect(items.map((i) => i.key)).toEqual(["3", "7"]); // oldest (lowest number) first
    const item = items[1]!;
    expect(item.sourceType).toBe("github_issues");
    if (!isGithubIssuesItem(item)) throw new Error("unreachable");
    expect(item).toMatchObject({ key: "7", displayKey: "#7", number: 7, summary: "Crash on save", type: "Bug", repo: "acme/tracker", state: "open" });
    expect(item.labels).toContain("herdr");
    expect(item.assignees).toEqual(["pat"]);
    expect(item.url).toContain("/issues/7");
  });

  it("excludes PRs (the issues list interleaves them) and items carrying in-flight state labels", async () => {
    fake = makeFakeGithub();
    fake.addIssue(1, { labels: ["herdr"], pull_request: {} }); // actually a PR
    fake.addIssue(2, { labels: ["herdr", "herdr:in-development"] }); // partial claim / hand-edit
    fake.addIssue(3, { labels: ["herdr", "herdr:in-review"] });
    fake.addIssue(4, { labels: ["herdr", "herdr:aborted"] }); // aborted does NOT gate — retry affordance
    fake.addIssue(5, { labels: ["herdr"] });
    const items = await makeSource(fake).listEligible();
    expect(items.map((i) => i.key)).toEqual(["4", "5"]);
  });

  it("issue type: native issue type wins, then type_labels, then default_type", async () => {
    fake = makeFakeGithub();
    fake.addIssue(1, { labels: ["herdr", "bug"], type: { name: "Task" } }); // native wins over the bug label
    fake.addIssue(2, { labels: ["herdr", "defect"] }); // type_labels: defect → Bug
    fake.addIssue(3, { labels: ["herdr"] }); // default
    const items = await makeSource(fake).listEligible();
    expect(items.map((i) => i.type)).toEqual(["Task", "Bug", "Feature"]);
  });
});

describe("GithubIssuesSource — describe", () => {
  it("returns the canonical bare-number key even for a '#123' spelling (INV-11)", async () => {
    fake = makeFakeGithub();
    fake.addIssue(12, { title: "T12", labels: ["herdr", "bug"] });
    const t = await makeSource(fake).describe("#12");
    expect(t).toMatchObject({ key: "12", displayKey: "#12", summary: "T12", type: "Bug" });
  });

  it("throws for an unknown number, a non-number, and a PR", async () => {
    fake = makeFakeGithub();
    fake.addIssue(5, { pull_request: {} });
    const src = makeSource(fake);
    await expect(src.describe("999")).rejects.toThrow();
    await expect(src.describe("not-a-number")).rejects.toThrow("not an issue number");
    await expect(src.describe("5")).rejects.toThrow("pull request");
  });
});

describe("GithubIssuesSource — transitions (GET → diff → apply)", () => {
  it("in_development: adds the state label, consumes the trigger label LAST; idempotent re-delivery is a noop", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7);
    const src = makeSource(fake);
    expect(await src.transition("7", "in_development")).toEqual({ kind: "applied" });
    const labels = fake.issues.get(7)!.labels;
    expect(labels.has("herdr:in-development")).toBe(true);
    expect(labels.has("herdr")).toBe(false); // trigger consumed → drops out of listEligible (INV-1)
    expect(await src.transition("7", "in_development")).toEqual({ kind: "noop" }); // outbox retry
    // The add-then-remove ordering: the label POST must come before the trigger DELETE.
    const mutating = fake.calls.filter((c) => c.method === "POST" || c.method === "DELETE").map((c) => `${c.method} ${c.path}`);
    expect(mutating.indexOf("POST /repos/acme/tracker/issues/7/labels")).toBeLessThan(mutating.indexOf("DELETE /repos/acme/tracker/issues/7/labels/herdr"));
  });

  it("creates missing state labels lazily (and tolerates a 422 already-exists race)", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7);
    expect(fake.repoLabels.has("herdr:in-development")).toBe(false);
    await makeSource(fake).transition("7", "in_development");
    expect(fake.repoLabels.has("herdr:in-development")).toBe(true);
  });

  it("in_review: swaps the state labels; merged: strips labels + closes as completed", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7, { labels: ["herdr:in-development"] });
    const src = makeSource(fake);
    expect(await src.transition("7", "in_review")).toEqual({ kind: "applied" });
    expect([...fake.issues.get(7)!.labels]).toEqual(["herdr:in-review"]);
    expect(await src.transition("7", "merged")).toEqual({ kind: "applied" });
    const issue = fake.issues.get(7)!;
    expect(issue.state).toBe("closed");
    expect(issue.state_reason).toBe("completed");
    expect(issue.labels.size).toBe(0);
  });

  it("merged on an already-closed issue (auto-close won the race) is a noop — and never reopens", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7, { state: "closed", state_reason: "completed", labels: [] });
    expect(await makeSource(fake).transition("7", "merged")).toEqual({ kind: "noop" });
    expect(fake.issues.get(7)!.state).toBe("closed");
  });

  it("aborted: strips in-flight labels, adds the aborted artifact label, issue stays OPEN by default", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7, { labels: ["herdr:in-development"] });
    expect(await makeSource(fake).transition("7", "aborted")).toEqual({ kind: "applied" });
    const issue = fake.issues.get(7)!;
    expect(issue.state).toBe("open"); // visible, retriageable failure artifact
    expect([...issue.labels]).toEqual(["herdr:aborted"]);
  });

  it("close_on.aborted: true closes as not_planned", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7, { labels: ["herdr:in-development"] });
    await makeSource(fake, { closeOn: { merged: true, done: true, aborted: true } }).transition("7", "aborted");
    const issue = fake.issues.get(7)!;
    expect(issue.state).toBe("closed");
    expect(issue.state_reason).toBe("not_planned");
  });

  it("unmapped state (todo) is a noop with ZERO network (INV-3)", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7);
    expect(await makeSource(fake).transition("7", "todo")).toEqual({ kind: "noop" });
    expect(fake.calls.length).toBe(0);
  });

  it("an issue closed by a human BEFORE the claim/review write-back is stale (cancel signal)", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7, { state: "closed", state_reason: "not_planned" });
    const src = makeSource(fake);
    expect((await src.transition("7", "in_development")).kind).toBe("stale");
    expect((await src.transition("7", "in_review")).kind).toBe("stale");
  });

  it("in_review on an issue closed as COMPLETED is a noop — auto-close racing a fast merge, not a cancel", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7, { state: "closed", state_reason: "completed" });
    const src = makeSource(fake);
    expect((await src.transition("7", "in_review")).kind).toBe("noop"); // PR watch owns the real signal
    expect((await src.transition("7", "in_development")).kind).toBe("stale"); // at claim time it's still a cancel
  });

  it("410 (deleted), 301 (transferred), 404 (inaccessible) → stale with ZERO mutations issued", async () => {
    fake = makeFakeGithub();
    const src = makeSource(fake);
    for (const [n, status, why] of [[1, 410, "deleted"], [2, 301, "transferred"], [3, 404, "not found"]] as const) {
      fake.addIssue(n, { labels: ["herdr:in-development"] });
      fake.gone.set(n, status);
      const res = await src.transition(String(n), "merged");
      expect(res.kind).toBe("stale");
      expect(res.detail).toContain(why);
    }
    expect(fake.mutations()).toBe(0); // the stale probe is the GET; nothing was written anywhere
  });

  it("DELETE of an already-absent label (documented 404) is tolerated, not an error", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7, { labels: ["herdr", "herdr:in-review"] }); // in-dev label already absent
    // in_review wants to remove in-development (absent) — must not throw, and land applied for
    // the trigger/label work that DID happen.
    expect((await makeSource(fake).transition("7", "in_review")).kind).toBe("noop"); // already in review + nothing else to do
  });
});

describe("GithubIssuesSource — materialize", () => {
  it("renders task.md (header + closing reference + body + human comments), writes issue.json, idempotent", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7, { title: "Crash on save", body: "It crashes.\n\n<!-- hidden instruction -->Steps included.", labels: ["herdr", "bug"] });
    fake.addComment(7, "[herdr-factory] ⚠ an old bot note"); // must be excluded
    fake.addComment(7, "Repro: click save twice.", "helpful-human");
    const src = makeSource(fake);
    const dir = mem();
    await src.materialize("7", dir, () => {});
    const task = readFileSync(join(dir, "task.md"), "utf8");
    expect(task).toContain("# Issue #7: Crash on save");
    expect(task).toContain("- Closing reference: Fixes #7"); // same-repo → docs-guaranteed short form
    expect(task).toContain("It crashes.");
    expect(task).not.toContain("hidden instruction"); // HTML comments sanitized out of prompt text
    expect(task).toContain("Repro: click save twice.");
    expect(task).not.toContain("an old bot note");
    expect(existsSync(join(dir, "issue.json"))).toBe(true);
    const raw = JSON.parse(readFileSync(join(dir, "issue.json"), "utf8"));
    expect(raw.issue.body).toContain("hidden instruction"); // the raw payload keeps everything

    const before = fake.calls.length;
    await src.materialize("7", dir, () => {}); // idempotent — no refetch
    expect(fake.calls.length).toBe(before);
  });

  it("uses the qualified closing reference when the issues repo differs from the PR repo", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7);
    const src = makeSource(fake, {}, "acme/product"); // PRs open on acme/product; issues live on acme/tracker
    const dir = mem();
    await src.materialize("7", dir, () => {});
    expect(readFileSync(join(dir, "task.md"), "utf8")).toContain("- Closing reference: Fixes acme/tracker#7");
  });

  it("logs and returns (no task.md) when the issue can't be fetched — the next tick retries", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7);
    fake.gone.set(7, 404);
    const warnings: string[] = [];
    const dir = mem();
    await makeSource(fake).materialize("7", dir, (_l, m) => warnings.push(m));
    expect(existsSync(join(dir, "task.md"))).toBe(false);
    expect(warnings.length).toBe(1);
  });
});

describe("GithubIssuesSource — human loop", () => {
  it("askHuman posts a marked question once and is idempotent per questionId (INV-5)", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7);
    const src = makeSource(fake);
    const input = { repo: "demo", runId: 4, questionId: 9, key: "7", step: "fix", question: "Which flag wins?" };
    const first = await src.askHuman(input);
    expect(first.externalId).toBeTruthy();
    const again = await src.askHuman(input); // response lost → re-invoked; must find, not re-post
    expect(again.externalId).toBe(first.externalId);
    expect(fake.issues.get(7)!.comments.length).toBe(1);
    expect(fake.issues.get(7)!.comments[0]!.body).toContain("[herdr-factory question: demo/4/9]");
  });

  it("pollHumanReply skips herdr artifacts + pre-question comments, accepts quote-replies, and never author-filters", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7);
    fake.addComment(7, "an OLD human comment before the question"); // created before → excluded
    const src = makeSource(fake);
    const q = await src.askHuman({ repo: "demo", runId: 4, questionId: 9, key: "7", step: "fix", question: "Which flag wins?" });
    const input = { key: "7", questionId: 9, externalId: q.externalId, externalCreatedAt: q.externalCreatedAt };
    expect(await src.pollHumanReply(input)).toBeNull();
    await src.postNote("7", "⚠ parked for attention"); // marked note — must not read as a reply
    expect(await src.pollHumanReply(input)).toBeNull();
    // The reply arrives as a QUOTE-REPLY (GitHub UI) that embeds the question's marker — and from
    // the SAME login the bot posts under (shared gh-CLI identity): both must be accepted.
    fake.addComment(7, "> [herdr-factory question: demo/4/9]\n\nUse the new flag.", "operator");
    const reply = await src.pollHumanReply(input);
    expect(reply).not.toBeNull();
    expect(reply!.body).toContain("Use the new flag.");
    expect(reply!.author).toBe("operator");
  });

  it("askHuman/pollHumanReply on a gone issue throw StaleItemError (escalates instead of polling forever)", async () => {
    fake = makeFakeGithub();
    fake.addIssue(7);
    fake.gone.set(7, 410);
    const src = makeSource(fake);
    await expect(src.askHuman({ repo: "demo", runId: 4, questionId: 9, key: "7", step: "fix", question: "?" })).rejects.toThrow(StaleItemError);
    await expect(src.pollHumanReply({ key: "7", questionId: 9, externalId: "1", externalCreatedAt: null })).rejects.toThrow(StaleItemError);
  });
});

describe("GithubIssuesSource — health", () => {
  it("passes on a healthy repo; fails actionably on disabled issues, no push, or a missing trigger label", async () => {
    fake = makeFakeGithub();
    const src = makeSource(fake);
    await expect(src.health()).resolves.toBeUndefined();
    fake.repoLabels.delete("herdr");
    await expect(src.health()).rejects.toThrow('trigger label "herdr" does not exist');
    fake.repoLabels.add("herdr");
    fake.push = false;
    await expect(src.health()).rejects.toThrow("no push/write access");
    fake.push = true;
    fake.hasIssues = false;
    await expect(src.health()).rejects.toThrow("issues are disabled");
  });
});

describe("GithubIssuesSource — workDoc", () => {
  it("names task.md without touching the network", async () => {
    fake = makeFakeGithub();
    const wd = await makeSource(fake).workDoc();
    expect(wd.path).toBe("task.md");
    expect(fake.calls.length).toBe(0);
  });
});
