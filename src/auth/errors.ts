// The typed "this work source isn't authenticated" signal. Distinct from a generic backend error
// (network/5xx/rate-limit) so the reconciler can react specifically: pause the source's claims +
// status write-backs, surface an auth light, notify ONCE, and auto-resume when auth returns —
// rather than silently degrading to [] (the poll path) or retrying forever (the outbox).
//
// A source client throws this from two places:
//   - "missing"  — no credentials are present/bootstrappable at all (before any network call).
//   - "rejected" — credentials were sent but the backend answered 401/403 (they're wrong/expired).
//
// Phase 2 (OAuth) reuses this same error: an unrefreshable access token throws "rejected", an
// absent refresh token throws "missing". `hint` carries the actionable remediation for the operator.

export interface SourceUnauthenticatedInit {
  reason: "missing" | "rejected";
  /** Actionable remediation shown to the operator (which env key / which login command). */
  hint?: string;
  /** The configured source name, when the thrower knows it (the reconciler otherwise attaches it). */
  sourceName?: string;
  cause?: unknown;
}

export class SourceUnauthenticatedError extends Error {
  readonly reason: "missing" | "rejected";
  readonly hint?: string;
  sourceName?: string;
  constructor(init: SourceUnauthenticatedInit) {
    super(init.hint ?? `work source not authenticated (${init.reason})`, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "SourceUnauthenticatedError";
    this.reason = init.reason;
    this.hint = init.hint;
    this.sourceName = init.sourceName;
  }
}

export function isSourceUnauthenticated(e: unknown): e is SourceUnauthenticatedError {
  return e instanceof SourceUnauthenticatedError;
}
