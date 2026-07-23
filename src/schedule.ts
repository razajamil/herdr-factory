// The deliver-lane scheduling SPINE: the retry/notify arithmetic every durable-intent mechanism
// shares, defined once. The outbox family (transition_outbox, evidence_uploads) and the
// human-question reply poll each re-typed the same 60s-doubling curve, and four notify throttles
// re-implemented the same "fire when never-notified or past the window" check against the one
// `attention_renotify_seconds` knob — this module is where that shape lives now.
//
// A pure LEAF (no imports) so db/, core/ and watchers/ can all depend on it without a cycle.
// Deliberately arithmetic-only: each mechanism keeps its own table, columns, terminal-state
// vocabulary, ordering rules (per-run FIFO, supersede-on-enqueue) and reset semantics — those
// divergences are per-mechanism POLICY (see docs/ARCHITECTURE.md §6/§7), not duplication. Only the
// shared numbers and curves belong here.

/** First-retry delay of the shared exponential backoff (seconds). */
export const RETRY_BASE_SECONDS = 60;

/** Backoff cap for the durable outboxes (transition write-backs, evidence uploads): retries thin
 *  out to at most one per hour, forever — an outbox intent never gives up on its own. */
export const OUTBOX_BACKOFF_CAP_SECONDS = 3600;

/** Backoff cap for the human-reply poll: humans answer in minutes-to-hours, so polls settle at one
 *  per 5 minutes — frequent enough that an answer resumes the run promptly, sparse enough that a
 *  pile of waiting runs isn't sustained source-API load. */
export const HUMAN_POLL_BACKOFF_CAP_SECONDS = 300;

/**
 * The shared retry curve: 60s doubling per attempt, capped. `attempts` is the attempt just
 * recorded (1-based), so attempt 1 → 60s, 2 → 120s, 3 → 240s, … up to `capSeconds`.
 */
export function backoffDelaySeconds(attempts: number, capSeconds: number): number {
  return Math.min(RETRY_BASE_SECONDS * 2 ** (attempts - 1), capSeconds);
}

/**
 * The shared notify throttle: fire when never notified (`lastNotifiedAt` null/undefined — a null
 * must always fire, never be read as "notified at epoch 0"), or when the throttle window has
 * elapsed since the last notification. Unit-agnostic — pass all three arguments in the same unit
 * (the engine's throttles are epoch seconds against `limits.attention_renotify_seconds`; the
 * updater's dirty-checkout throttle is epoch milliseconds against its own 6h constant).
 */
export function notifyDue(lastNotifiedAt: number | null | undefined, throttle: number, now: number): boolean {
  return lastNotifiedAt == null || now - lastNotifiedAt >= throttle;
}
