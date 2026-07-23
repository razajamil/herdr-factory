import { describe, expect, it } from "vitest";
import {
  backoffDelaySeconds,
  HUMAN_POLL_BACKOFF_CAP_SECONDS,
  notifyDue,
  OUTBOX_BACKOFF_CAP_SECONDS,
} from "../src/schedule.ts";

// The extracted deliver-lane scheduling spine must be curve-identical to the four inline
// implementations it replaced (transition outbox, evidence outbox, human-poll miss, human-poll
// error) — these pin the exact values the outbox/poll tests were written against.

describe("backoffDelaySeconds", () => {
  it("doubles from 60s per attempt", () => {
    expect(backoffDelaySeconds(1, OUTBOX_BACKOFF_CAP_SECONDS)).toBe(60);
    expect(backoffDelaySeconds(2, OUTBOX_BACKOFF_CAP_SECONDS)).toBe(120);
    expect(backoffDelaySeconds(3, OUTBOX_BACKOFF_CAP_SECONDS)).toBe(240);
    expect(backoffDelaySeconds(6, OUTBOX_BACKOFF_CAP_SECONDS)).toBe(1920);
  });

  it("caps at 1h for the outboxes (attempt 7 onward)", () => {
    expect(backoffDelaySeconds(7, OUTBOX_BACKOFF_CAP_SECONDS)).toBe(3600);
    expect(backoffDelaySeconds(50, OUTBOX_BACKOFF_CAP_SECONDS)).toBe(3600);
  });

  it("caps at 5min for the human-reply poll (attempt 4 onward)", () => {
    expect(backoffDelaySeconds(3, HUMAN_POLL_BACKOFF_CAP_SECONDS)).toBe(240);
    expect(backoffDelaySeconds(4, HUMAN_POLL_BACKOFF_CAP_SECONDS)).toBe(300);
    expect(backoffDelaySeconds(20, HUMAN_POLL_BACKOFF_CAP_SECONDS)).toBe(300);
  });
});

describe("notifyDue", () => {
  it("always fires when never notified — null is not epoch 0", () => {
    expect(notifyDue(null, 3600, 1_000_000)).toBe(true);
    expect(notifyDue(undefined, 3600, 1_000_000)).toBe(true);
  });

  it("holds inside the throttle window, fires at and past it", () => {
    expect(notifyDue(1_000_000, 3600, 1_000_000 + 3599)).toBe(false);
    expect(notifyDue(1_000_000, 3600, 1_000_000 + 3600)).toBe(true);
    expect(notifyDue(1_000_000, 3600, 1_000_000 + 9999)).toBe(true);
  });

  it("is unit-agnostic (the updater passes milliseconds)", () => {
    const sixHoursMs = 6 * 60 * 60 * 1000;
    const now = 1_700_000_000_000;
    expect(notifyDue(now - sixHoursMs + 1, sixHoursMs, now)).toBe(false);
    expect(notifyDue(now - sixHoursMs, sixHoursMs, now)).toBe(true);
  });
});
