// Assertion vocabulary. The engine's event timeline is the contract a scenario asserts against, so
// most of these are ordering assertions over event-type lists — deliberately SUBSEQUENCE-based, not
// equality: a scenario states the milestones it cares about and stays green when the engine grows a
// new event type in between.
import { expect } from "vitest";
import type { World } from "./world.ts";

/** `expected` must appear in `actual` in order (gaps allowed). */
export function expectSubsequence(actual: string[], expected: string[], what = "sequence"): void {
  let i = 0;
  const missing: string[] = [];
  for (const want of expected) {
    const at = actual.indexOf(want, i);
    if (at < 0) missing.push(want);
    else i = at + 1;
  }
  if (missing.length) {
    throw new Error(
      `${what}: expected subsequence not found.\n  missing (or out of order): ${missing.join(", ")}\n  actual: ${actual.join(" → ")}`,
    );
  }
}

/** The run's event timeline contains these types, in this order. */
export function expectTimeline(w: World, key: string, expected: string[]): void {
  expectSubsequence(w.db.eventTypes(key), expected, `timeline for ${key}`);
}

export function expectNoEvent(w: World, key: string, type: string): void {
  const types = w.db.eventTypes(key);
  if (types.includes(type)) throw new Error(`did not expect event "${type}" for ${key}; timeline: ${types.join(" → ")}`);
}

/** Every source status write-back the engine enqueued, in delivery order — the ordering invariant
 *  (a retried in_development must never land after in_review) is asserted with this. */
export function transitions(w: World, key: string): string[] {
  return w.db
    .events(key)
    .filter((e) => e.type === "transition")
    .map((e) => {
      try {
        return String((JSON.parse(e.detail ?? "{}") as { to?: string }).to ?? "?");
      } catch {
        return "?";
      }
    });
}

export function expectParked(w: World, key: string, reasonCode: string): void {
  const r = w.db.run(key);
  expect(r, `run ${key} should exist`).toBeTruthy();
  expect(r?.phase, `${key} phase (attention_reason=${r?.attention_reason ?? "-"})`).toBe("attention");
  expect(r?.attention_reason_code, `${key} attention reason code`).toBe(reasonCode);
}

export function expectStepDone(w: World, key: string, steps: string[]): void {
  const r = w.db.run(key);
  expect(r, `run ${key} should exist`).toBeTruthy();
  const rows = w.db.steps(r!.id);
  for (const s of steps) {
    const row = rows.find((x) => x.step === s);
    expect(row, `${key} should have a run_steps row for "${s}" (has: ${rows.map((x) => x.step).join(", ")})`).toBeTruthy();
    expect(row?.done, `${key} step "${s}" done flag`).toBe(1);
  }
}

/** No intent may be left undelivered when a scenario ends cleanly — that is how a silently-retrying
 *  status write-back or evidence upload would otherwise hide. */
export function expectNoPendingIntents(w: World, opts: { except?: string[] } = {}): void {
  const stuck = w.db
    .intents()
    .filter((i) => i.status !== "delivered" && i.status !== "superseded")
    .filter((i) => !(opts.except ?? []).includes(i.kind));
  if (stuck.length) {
    throw new Error(
      `undelivered intents remain:\n${stuck
        .map((i) => `  ${i.kind} status=${i.status} attempts=${i.attempts} class=${i.error_class ?? "-"} err=${(i.last_error ?? "").slice(0, 160)}`)
        .join("\n")}`,
    );
  }
}

/** Assert a call budget over the fake gh's argv log (e.g. one batched GraphQL query per tick however
 *  many PRs are watched). */
export function expectCallBudget(calls: { subcommand: string }[], subcommand: string, max: number): void {
  const n = calls.filter((c) => c.subcommand === subcommand).length;
  if (n > max) throw new Error(`gh "${subcommand}" was called ${n} times, budget is ${max}`);
}
