import { describe, it, expect } from "vitest";
import { openDb } from "../src/db/index.ts";
import { Store } from "../src/db/store.ts";

function makeStore(start = 1000) {
  let now = start;
  const db = openDb(":memory:");
  const store = new Store(db, () => now);
  return { store, db, setNow: (n: number) => { now = n; }, tick: (d: number) => { now += d; } };
}

describe("Store", () => {
  it("creates a run in claiming and counts it active", () => {
    const { store } = makeStore();
    const run = store.createRun({ repo: "r", ticketKey: "K-1", summary: "s", issueType: "Bug", branch: "fix/K-1-s" });
    expect(run.phase).toBe("claiming");
    expect(run.workerDone).toBe(false);
    expect(store.countActive("r")).toBe(1);
    expect(store.activeRunForTicket("r", "K-1")?.id).toBe(run.id);
  });

  it("updates fields and bumps updated_at", () => {
    const { store, tick } = makeStore(1000);
    const run = store.createRun({ repo: "r", ticketKey: "K-2" });
    tick(5);
    store.updateRun(run.id, { phase: "developing", prNumber: 42, workerDone: true, workspaceId: "w1" });
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("developing");
    expect(got.prNumber).toBe(42);
    expect(got.workerDone).toBe(true);
    expect(got.workspaceId).toBe("w1");
    expect(got.updatedAt).toBe(1005);
  });

  it("ends a run -> not active, has outcome + ended_at", () => {
    const { store } = makeStore();
    const run = store.createRun({ repo: "r", ticketKey: "K-3" });
    store.endRun(run.id, "merged");
    expect(store.countActive("r")).toBe(0);
    const got = store.getRun(run.id)!;
    expect(got.phase).toBe("done");
    expect(got.outcome).toBe("merged");
    expect(got.endedAt).not.toBeNull();
  });

  it("supports multiple attempts per ticket and keeps history", () => {
    const { store, db } = makeStore();
    const a = store.createRun({ repo: "r", ticketKey: "K-4" });
    store.endRun(a.id, "closed");
    const b = store.createRun({ repo: "r", ticketKey: "K-4" }); // re-claim after a failed attempt
    expect(store.countActive("r")).toBe(1);
    expect(store.activeRunForTicket("r", "K-4")?.id).toBe(b.id);
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE ticket_key = 'K-4'").get() as { n: number };
    expect(n).toBe(2);
  });

  it("records events with JSON detail", () => {
    const { store, db } = makeStore();
    const run = store.createRun({ repo: "r", ticketKey: "K-5" });
    store.recordEvent({ runId: run.id, repo: "r", ticketKey: "K-5", type: "claimed" });
    store.recordEvent({ runId: run.id, repo: "r", ticketKey: "K-5", type: "pr_opened", detail: { number: 7 } });
    const evs = db.prepare("SELECT type, detail FROM events WHERE run_id = ? ORDER BY id").all(run.id) as {
      type: string;
      detail: string | null;
    }[];
    expect(evs.map((e) => e.type)).toEqual(["claimed", "pr_opened"]);
    expect(JSON.parse(evs[1]!.detail!)).toEqual({ number: 7 });
  });

  it("TTL lock: acquire, block, steal after expiry, release", () => {
    const { store, setNow } = makeStore(1000);
    expect(store.acquireLock("capture", "A", 100)).toBe(true); // held until 1100
    expect(store.acquireLock("capture", "B", 100)).toBe(false); // blocked
    setNow(1101); // A expired
    expect(store.acquireLock("capture", "B", 100)).toBe(true); // steal
    store.releaseLock("capture", "A"); // wrong owner -> no-op
    expect(store.acquireLock("capture", "C", 100)).toBe(false); // B still holds
    store.releaseLock("capture", "B");
    expect(store.acquireLock("capture", "C", 100)).toBe(true);
  });
});
