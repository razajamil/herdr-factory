import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.ts";
import { Store } from "../src/db/store.ts";
import { flushOutbox } from "../src/core/outbox.ts";
import { consumeIntentHandoffs, ledgerFlow } from "../src/core/ledger.ts";
import type { IntentKindDef, IntentOutcome } from "../src/intents/registry.ts";
import { intentKindFor } from "../src/intents/registry.ts";
import type { Deps } from "../src/core/deps.ts";
import type { Run } from "../src/types.ts";

// The intent-ledger contract suite — the analog of the work-source/step-descriptor contract
// suites: what "is a ledger kind" means behaviorally (idempotent enqueue, FIFO blocking, backoff
// on the kind's curve, exactly-once handoff consume), pinned against fake kinds so the kernel's
// mechanics are tested apart from any shipped kind's semantics.

function makeStore(startNow = 1000) {
  let now = startNow;
  const store = new Store(openDb(":memory:"), () => now);
  // intents.run_id REFERENCES runs(id) (foreign_keys ON) — run-scoped test rows need a real run.
  const run = store.createRun({ repo: "r", workSource: "src", belt: "b", ticketKey: "K-1" });
  return { store, run, setNow: (n: number) => (now = n), now: () => now };
}

/** The minimal Deps surface the kernel touches (store/config/now/log/herdr.notify). */
function makeDeps(store: Store, now: () => number, notifies: string[] = []): Deps {
  return {
    store,
    now,
    log: () => {},
    config: { repoName: "r", limits: { attentionRenotifySeconds: 3600 } },
    herdr: {
      notify: async (title: string) => {
        notifies.push(title);
      },
    },
  } as unknown as Deps;
}

const enqueue = (store: Store, over: Partial<Parameters<Store["enqueueIntent"]>[0]> = {}) =>
  store.enqueueIntent({ repo: "r", kind: "k", scope: "run:1", runId: 1, ticketKey: "K-1", ...over });

describe("intents store — enqueue/dedup/FIFO/lease mechanics", () => {
  it("enqueue is idempotent per (kind, scope, dedupKey): a re-enqueue re-opens, KEEPING the FIFO slot", () => {
    const { store, setNow } = makeStore();
    const a = enqueue(store, { dedupKey: "d1", payload: '{"v":1}' });
    expect(a.seq).toBe(a.id); // slot stamped on first insert
    store.markIntentDelivered(a.id);
    // A later, different intent takes a later slot...
    const b = enqueue(store, { dedupKey: "d2" });
    expect(b.seq).toBeGreaterThan(a.seq);
    // ...and re-opening the first keeps its ORIGINAL slot + id, with the fresh payload.
    setNow(2000);
    const reopened = enqueue(store, { dedupKey: "d1", payload: '{"v":2}' });
    expect(reopened.id).toBe(a.id);
    expect(reopened.seq).toBe(a.seq);
    expect(reopened.status).toBe("pending");
    expect(reopened.payload).toBe('{"v":2}');
    expect(reopened.resolvedAt).toBeNull();
  });

  it("supersedeScope (latest-wins): enqueue closes the scope's other live rows, keeping their outcome", () => {
    const { store } = makeStore();
    const a = enqueue(store, { dedupKey: "old" });
    const b = enqueue(store, { dedupKey: "new", supersedeScope: true });
    expect(store.getIntent(a.id)!.status).toBe("superseded");
    expect(store.getIntent(b.id)!.status).toBe("pending");
    // A resolved row is not touched by later supersessions.
    store.markIntentDelivered(b.id);
    enqueue(store, { dedupKey: "newer", supersedeScope: true });
    expect(store.getIntent(b.id)!.status).toBe("delivered");
  });

  it("earlierPendingIntentInScope blocks on an earlier UNRESOLVED sibling even when it isn't due", () => {
    const { store } = makeStore();
    const a = enqueue(store, { dedupKey: "first" });
    store.recordIntentAttempt(a.id, "backend down", "transient", 3600); // backed off — NOT due
    const b = enqueue(store, { dedupKey: "second" });
    expect(store.earlierPendingIntentInScope("k", "run:1", b.seq)).toBe(true);
    store.markIntentDelivered(a.id);
    expect(store.earlierPendingIntentInScope("k", "run:1", b.seq)).toBe(false);
  });

  it("dueIntents honors backoff AND the inline lease; attempts clear the lease", () => {
    const { store, setNow } = makeStore();
    const a = enqueue(store, { dedupKey: "leased", leaseUntil: 1300 });
    expect(store.dueIntents("r").map((i) => i.id)).toEqual([]); // leased — the flush must not steal it
    setNow(1301);
    expect(store.dueIntents("r").map((i) => i.id)).toEqual([a.id]); // lease expired → claimable
    store.recordIntentAttempt(a.id, "boom", "transient", 60);
    expect(store.getIntent(a.id)!.leaseUntil).toBeNull();
    expect(store.dueIntents("r")).toEqual([]); // backed off
    setNow(1362);
    expect(store.dueIntents("r").map((i) => i.id)).toEqual([a.id]);
  });

  it("requeueIntentsByCause is repo+cause scoped, optionally by error class; fulfil only fires on waiting rows", () => {
    const { store, setNow } = makeStore();
    const auth = enqueue(store, { dedupKey: "a", causeScope: "publisher:s3" });
    const flaky = enqueue(store, { dedupKey: "b", causeScope: "publisher:s3" });
    store.recordIntentAttempt(auth.id, "sso expired", "auth", 3600);
    store.recordIntentAttempt(flaky.id, "500", "transient", 3600);
    setNow(1100);
    expect(store.requeueIntentsByCause("r", "publisher:s3", "auth")).toBe(1); // auth-stuck only
    expect(store.getIntent(auth.id)!.nextAttemptAt).toBe(1100);
    expect(store.getIntent(flaky.id)!.nextAttemptAt).toBe(1000 + 3600);
    // fulfil: pending rows are not fulfillable; waiting rows resolve + hand off exactly once.
    expect(store.fulfilIntent(auth.id)).toBeUndefined();
    const wait = enqueue(store, { dedupKey: "w", status: "waiting" });
    const fulfilled = store.fulfilIntent(wait.id, '{"ok":true}')!;
    expect(fulfilled.status).toBe("delivered");
    expect(fulfilled.handoffMarker).toBe("fulfilled");
    expect(store.fulfilIntent(wait.id)).toBeUndefined(); // second fulfil is a no-op
  });

  it("abandonIntentsForRun drops only live rows of the given kinds; a repo-scoped handoff self-acknowledges", () => {
    const { store } = makeStore();
    const keep = enqueue(store, { kind: "keep", dedupKey: "x" });
    const drop = enqueue(store, { kind: "drop", dedupKey: "y" });
    expect(store.abandonIntentsForRun(1, "torn down", ["drop"])).toBe(1);
    expect(store.getIntent(drop.id)!.status).toBe("abandoned");
    expect(store.getIntent(keep.id)!.status).toBe("pending");
    // A handoff with no run has no consumer loop — stamped consumed immediately.
    const repoScoped = enqueue(store, { kind: "keep", scope: "repo", runId: null, dedupKey: "z" });
    store.markIntentHandoff(repoScoped.id, "fulfilled");
    expect(store.getIntent(repoScoped.id)!.consumedResult).toBe("acknowledged (no run)");
  });
});

describe("ledger kernel — outcome application, FIFO gate, deadlines, notify throttle", () => {
  const fakeKind = (kind: string, deliver: (deps: Deps, row: import("../src/types.ts").Intent) => Promise<IntentOutcome>, over: Partial<IntentKindDef> = {}): IntentKindDef => ({
    kind,
    ordering: "independent",
    retryCapSeconds: 3600,
    deliver,
    ...over,
  });

  it("applies each outcome: delivered / retry (kind curve) / reschedule (no attempt) / failed / handoff", async () => {
    const { store, now } = makeStore();
    const deps = makeDeps(store, now);
    const rows = {
      ok: enqueue(store, { kind: "ok", dedupKey: "1" }),
      retry: enqueue(store, { kind: "retry", dedupKey: "2" }),
      resched: enqueue(store, { kind: "resched", dedupKey: "3" }),
      fail: enqueue(store, { kind: "fail", dedupKey: "4" }),
      hand: enqueue(store, { kind: "hand", dedupKey: "5" }),
    };
    const kinds = [
      fakeKind("ok", async () => ({ kind: "delivered" })),
      fakeKind("retry", async () => ({ kind: "retry", error: "e", errorClass: "transient" })),
      fakeKind("resched", async () => ({ kind: "reschedule", delaySeconds: 120, state: '{"misses":1}' })),
      fakeKind("fail", async () => ({ kind: "failed", reason: "config gone" })),
      fakeKind("hand", async () => ({ kind: "handoff", marker: "stale", resolve: "delivered" })),
    ];
    await flushOutbox(deps, ledgerFlow(deps, kinds));
    expect(store.getIntent(rows.ok.id)!.status).toBe("delivered");
    const r = store.getIntent(rows.retry.id)!;
    expect(r.attempts).toBe(1);
    expect(r.nextAttemptAt).toBe(now() + 60); // shared curve, attempt 1
    const rs = store.getIntent(rows.resched.id)!;
    expect(rs.attempts).toBe(0); // a miss is not an error
    expect(rs.nextAttemptAt).toBe(now() + 120);
    expect(rs.state).toBe('{"misses":1}');
    expect(store.getIntent(rows.fail.id)!.status).toBe("failed");
    const h = store.getIntent(rows.hand.id)!;
    expect(h.status).toBe("delivered");
    expect(h.handoffMarker).toBe("stale");
    expect(h.consumedAt).toBeNull(); // owed to the run-locked consume
  });

  it("FIFO ordering: a due row is blocked behind its scope's earlier, backed-off sibling", async () => {
    const { store, setNow, now } = makeStore();
    const deps = makeDeps(store, now);
    const attempts: string[] = [];
    const kinds = [
      fakeKind("f", async (_d, row) => {
        attempts.push(row.dedupKey);
        // "first" fails once, then delivers — the shape that leaves it backed off while "second"
        // is due, which is exactly what the DB-checked gate must block on.
        return row.dedupKey === "first" && row.attempts === 0 ? { kind: "retry", error: "down", errorClass: "transient" } : { kind: "delivered" };
      }, { ordering: "fifo" }),
    ];
    enqueue(store, { kind: "f", dedupKey: "first" });
    enqueue(store, { kind: "f", dedupKey: "second" });
    await flushOutbox(deps, ledgerFlow(deps, kinds)); // first fails (backs off 60s); second is due but BLOCKED
    expect(attempts).toEqual(["first"]);
    setNow(1061);
    // first (due again) delivers; second unblocks within the same pass — the gate re-checks the DB,
    // not a pass-start snapshot (the legacy transition-outbox semantics).
    await flushOutbox(deps, ledgerFlow(deps, kinds));
    expect(attempts).toEqual(["first", "first", "second"]);
    expect(store.listIntents("r", { kind: "f" }).every((i) => i.status === "delivered")).toBe(true);
  });

  it("a waiting row past its deadline fails + hands off 'deadline'; an unknown kind is closed out loudly", async () => {
    const { store, setNow, now } = makeStore();
    const deps = makeDeps(store, now);
    const wait = enqueue(store, { kind: "external_wait", dedupKey: "w", status: "waiting", deadlineAt: 1500 });
    const orphan = enqueue(store, { kind: "gone_kind", dedupKey: "o" });
    setNow(1501);
    await flushOutbox(deps, ledgerFlow(deps, [])); // no kinds registered at all
    const w = store.getIntent(wait.id)!;
    expect(w.status).toBe("failed");
    expect(w.handoffMarker).toBe("deadline");
    expect(store.getIntent(orphan.id)!.status).toBe("failed"); // unknown kind → closed, not retried forever
  });

  it("notify is throttled per row by attention_renotify_seconds", async () => {
    const { store, setNow, now } = makeStore();
    const notifies: string[] = [];
    const deps = makeDeps(store, now, notifies);
    const kinds = [
      fakeKind("n", async () => ({ kind: "retry", error: "sso", errorClass: "auth" }), {
        notify: () => ({ title: "auth stuck", body: "log in again" }),
      }),
    ];
    enqueue(store, { kind: "n", dedupKey: "1" });
    await flushOutbox(deps, ledgerFlow(deps, kinds));
    expect(notifies).toEqual(["auth stuck"]);
    setNow(1061); // due again, but inside the notify window
    await flushOutbox(deps, ledgerFlow(deps, kinds));
    expect(notifies).toEqual(["auth stuck"]);
    setNow(1000 + 3700); // past the throttle
    await flushOutbox(deps, ledgerFlow(deps, kinds));
    expect(notifies).toEqual(["auth stuck", "auth stuck"]);
  });
});

describe("consumeIntentHandoffs — the run-locked half", () => {
  const run = { id: 1, ticketKey: "K-1" } as Run;

  it("consumes each handoff exactly once; no consume() ⇒ acknowledged; a throw ⇒ rejected, not retried", async () => {
    const { store, now } = makeStore(); // makeStore's run is id 1 (first insert)
    const deps = makeDeps(store, now);
    const plain = enqueue(store, { kind: "plain", dedupKey: "1" });
    const throwing = enqueue(store, { kind: "boom", dedupKey: "2" });
    store.markIntentHandoff(plain.id, "fulfilled");
    store.markIntentHandoff(throwing.id, "fulfilled");
    const kinds: IntentKindDef[] = [
      { kind: "boom", ordering: "independent", retryCapSeconds: 60, deliver: async () => ({ kind: "delivered" }), consume: async () => { throw new Error("kaput"); } },
    ];
    expect(await consumeIntentHandoffs(deps, run, kinds)).toBeNull();
    expect(store.getIntent(plain.id)!.consumedResult).toBe("acknowledged");
    expect(store.getIntent(throwing.id)!.consumedResult).toMatch(/^rejected: consume threw/);
    // Second pass: nothing left to consume.
    expect(store.unconsumedIntentHandoffsForRun(1)).toEqual([]);
  });

  it("returns the FIRST escalation verdict for the caller to apply", async () => {
    const { store, now } = makeStore();
    const deps = makeDeps(store, now);
    const row = enqueue(store, { kind: "esc", dedupKey: "1" });
    store.markIntentHandoff(row.id, "deadline");
    const kinds: IntentKindDef[] = [
      {
        kind: "esc",
        ordering: "independent",
        retryCapSeconds: 60,
        deliver: async () => ({ kind: "delivered" }),
        consume: async () => ({ result: "escalated", escalate: { reason: "external_wait_deadline", attentionReason: "wait expired", body: "b" } }),
      },
    ];
    const escalate = await consumeIntentHandoffs(deps, run, kinds);
    expect(escalate).toMatchObject({ reason: "external_wait_deadline" });
    expect(store.getIntent(row.id)!.consumedResult).toBe("escalated");
  });
});

describe("shipped kinds", () => {
  it("external_wait is registered, externally enqueuable, and never survives teardown", () => {
    const k = intentKindFor("external_wait")!;
    expect(k.externallyEnqueuable).toBe(true);
    expect(k.survivesTeardown ?? false).toBe(false);
    expect(k.ordering).toBe("independent");
  });
});

describe("agent_signal on the ledger (v31 cutover)", () => {
  it("the pending-signal adapters keep the domain shapes: enqueue/supersede/consume round-trip", () => {
    const { store, run } = makeStore();
    const first = store.enqueuePendingSignal({ runId: run.id, repo: "r", ticketKey: "K-1", signal: "ask_human", step: "review", payload: "q1" });
    const second = store.enqueuePendingSignal({ runId: run.id, repo: "r", ticketKey: "K-1", signal: "bounce", step: "review", toStep: "fix", payload: "findings", pass: 2 });
    expect(store.getPendingSignal(first.id)!.consumedResult).toBe("superseded");
    const live = store.unconsumedPendingSignalForRun(run.id)!;
    expect(live).toMatchObject({ id: second.id, signal: "bounce", step: "review", toStep: "fix", payload: "findings", pass: 2 });
    store.markPendingSignalConsumed(second.id, "applied");
    expect(store.unconsumedPendingSignalForRun(run.id)).toBeUndefined();
    expect(store.getPendingSignal(second.id)!.consumedResult).toBe("applied");
    expect(store.getIntent(second.id)!.status).toBe("delivered"); // the row closed with the consume
  });

  it("agent_signal handoffs are invisible to the generic consume loop and to the kernel's due walk", async () => {
    const { store, run, now } = makeStore();
    const deps = makeDeps(store, now);
    const sig = store.enqueuePendingSignal({ runId: run.id, repo: "r", ticketKey: "K-1", signal: "bounce", step: "review", toStep: "fix", payload: "x" });
    // The generic run-locked loop must NOT acknowledge (eat) a reconciler-consumed kind's handoff…
    const { INTENT_KINDS } = await import("../src/intents/registry.ts");
    expect(await consumeIntentHandoffs(deps, { id: run.id, ticketKey: "K-1" } as Run, INTENT_KINDS)).toBeNull();
    expect(store.getIntent(sig.id)!.consumedAt).toBeNull();
    // …and the kernel's due walk must not touch a waiting/handoff row either.
    await flushOutbox(deps, ledgerFlow(deps));
    expect(store.getIntent(sig.id)!.status).toBe("waiting");
    expect(store.unconsumedPendingSignalForRun(run.id)!.id).toBe(sig.id); // still consumable
  });

  it("a legacy pending_signals row is lazily converted to a ledger row on first read (old-server drain)", () => {
    const { store, run } = makeStore();
    // Simulate a row a draining OLD-code process wrote directly into the legacy table.
    // @ts-expect-error reaching into the private db handle is deliberate here
    const db = store.db as import("node:sqlite").DatabaseSync;
    db.prepare(
      `INSERT INTO pending_signals (run_id, repo, ticket_key, signal, step, to_step, payload, pass, created_at)
       VALUES (?, 'r', 'K-1', 'bounce', 'review', 'fix', 'legacy findings', 3, 999)`,
    ).run(run.id);
    const converted = store.unconsumedPendingSignalForRun(run.id)!;
    expect(converted).toMatchObject({ signal: "bounce", step: "review", toStep: "fix", payload: "legacy findings", pass: 3 });
    expect(store.getIntent(converted.id)!.kind).toBe("agent_signal"); // it now lives on the ledger
    const legacy = db.prepare("SELECT consumed_result FROM pending_signals WHERE run_id = ?").get(run.id) as { consumed_result: string };
    expect(legacy.consumed_result).toContain("migrated");
    // Second read comes straight from the ledger (no duplicate conversion).
    expect(store.unconsumedPendingSignalForRun(run.id)!.id).toBe(converted.id);
  });

  it("migration v31 converts unconsumed legacy rows into waiting+handoff ledger rows and closes the old ones", () => {
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)");
    const { MIGRATIONS, migrate } = require("../src/db/migrate.ts") as typeof import("../src/db/migrate.ts");
    for (const m of MIGRATIONS.filter((m) => m.version <= 30)) {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(m.version);
    }
    db.prepare("INSERT INTO runs (repo, ticket_key, phase, created_at, updated_at) VALUES ('r','K-1','running',1,1)").run();
    db.prepare(
      `INSERT INTO pending_signals (run_id, repo, ticket_key, signal, step, to_step, payload, pass, created_at)
       VALUES (1, 'r', 'K-1', 'bounce', 'review', 'fix', 'pre-upgrade findings', 2, 500)`,
    ).run();
    migrate(db);
    const row = db.prepare("SELECT * FROM intents WHERE kind = 'agent_signal'").get() as Record<string, unknown>;
    expect(row).toMatchObject({ scope: "run:1", status: "waiting", handoff_marker: "signal", dedup_key: expect.stringMatching(/^legacy-/) });
    expect(JSON.parse(row.payload as string)).toMatchObject({ signal: "bounce", toStep: "fix", body: "pre-upgrade findings", pass: 2 });
    const legacy = db.prepare("SELECT consumed_result FROM pending_signals").get() as { consumed_result: string };
    expect(legacy.consumed_result).toContain("migrated to the intent ledger (v31)");
  });
});
