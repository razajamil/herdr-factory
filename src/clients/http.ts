// Effect-based HTTP for backend clients (Jira today). Every request is time-bounded and
// interruption-safe: Effect.tryPromise wires an AbortSignal that fires when the fiber is
// interrupted, so Effect.timeout doesn't just abandon the fetch — it cancels it. Item 6 of the
// reliability plan extends this same pipeline with rate limiting + retry schedules, which is why
// requests are exposed as Effects (composable) with a thin Promise wrapper for the clients.
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { runEffectPromise } from "../runtime/effect.ts";
import { telemetryEventEffect, withTelemetrySpan } from "../telemetry/effect.ts";

/** Default budget for a JSON API round-trip. Media downloads pass their own larger budget. */
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

export class HttpTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`HTTP request timed out after ${timeoutMs}ms: ${url}`);
    this.name = "HttpTimeoutError";
  }
}

/** The transport failed (DNS, refused, reset, aborted) — no HTTP response was received. */
export class HttpNetworkError extends Error {
  constructor(url: string, cause: unknown) {
    super(`HTTP request failed: ${url}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "HttpNetworkError";
  }
}

/** A non-2xx HTTP response, carrying what a retry policy needs (status + Retry-After). */
export class HttpStatusError extends Error {
  readonly status: number;
  readonly bodyText: string;
  readonly retryAfterMs: number | null;
  constructor(url: string, status: number, bodyText: string, retryAfterMs: number | null) {
    super(`HTTP ${status}: ${url}: ${bodyText.slice(0, 300)}`);
    this.name = "HttpStatusError";
    this.status = status;
    this.bodyText = bodyText;
    this.retryAfterMs = retryAfterMs;
  }
}

export type HttpError = HttpTimeoutError | HttpNetworkError | HttpStatusError;

export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  /** Response body. Decoded text for `httpExpectOk`; raw bytes for `httpOkBytes` (its `text` is
   *  a lossy decode kept for error reporting). */
  text: string;
  bytes: Buffer | null;
  headers: Headers;
}

function parseRetryAfter(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const at = Date.parse(raw); // HTTP-date form
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/**
 * One HTTP attempt as an Effect. Succeeds with the response body for ANY status; fails with
 * HttpTimeoutError / HttpNetworkError when no usable response arrived. Callers that want non-2xx
 * as a typed failure use `httpExpectOk`/`httpOkBytes`.
 */
function httpAttempt(req: HttpRequest, as: "text" | "bytes"): Effect.Effect<HttpResponse, HttpTimeoutError | HttpNetworkError> {
  const timeoutMs = req.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  return withTelemetrySpan(
    "http.client.backend",
    { "http.request.method": req.method ?? "GET", "url.full": req.url },
    Effect.tryPromise({
      // tryPromise's AbortSignal aborts on fiber interruption — so the timeout below really
      // cancels the in-flight fetch instead of leaving it running in the background.
      try: (signal) =>
        fetch(req.url, { method: req.method ?? "GET", headers: req.headers, body: req.body, redirect: "follow", signal }),
      catch: (cause) => new HttpNetworkError(req.url, cause),
    }).pipe(
      Effect.flatMap((res) =>
        Effect.tryPromise({
          try: async (): Promise<HttpResponse> => {
            if (as === "bytes") {
              const buf = Buffer.from(await res.arrayBuffer());
              // Bodies of failed byte requests are small error payloads — decode for reporting.
              const text = res.ok ? "" : buf.toString("utf8", 0, Math.min(buf.length, 1024));
              return { status: res.status, text, bytes: buf, headers: res.headers };
            }
            return { status: res.status, text: await res.text(), bytes: null, headers: res.headers };
          },
          catch: (cause) => new HttpNetworkError(req.url, cause),
        }),
      ),
      Effect.timeoutFail({
        duration: Duration.millis(timeoutMs),
        onTimeout: () => new HttpTimeoutError(req.url, timeoutMs),
      }),
    ),
    "client",
  );
}

/** httpAttempt + non-2xx lifted into a typed HttpStatusError (with Retry-After for rate-limit
 *  handling). The retry/rate-limit policies compose on top of this. */
export function httpExpectOk(req: HttpRequest, as: "text" | "bytes" = "text"): Effect.Effect<HttpResponse, HttpError> {
  return httpAttempt(req, as).pipe(
    Effect.flatMap((res) =>
      res.status >= 200 && res.status < 300
        ? Effect.succeed(res)
        : Effect.fail(new HttpStatusError(req.url, res.status, res.text, parseRetryAfter(res.headers))),
    ),
  );
}

// --- client-side rate limiting + retry ---------------------------------------

/**
 * A shared token bucket: `ratePerSec` sustained, `burst` peak. Guards a backend (one bucket per
 * JiraClient) so OUR OWN fan-out — a cold start claiming dozens of tickets, dozens of parked
 * runs polling for replies — can't stampede it into 429s. Time-based refill; no timers to manage.
 */
export class TokenBucket {
  // NOTE: no constructor parameter properties — the CLI runs this file via Node's strip-only
  // type-stripping, which doesn't support them.
  private readonly ratePerSec: number;
  private readonly burst: number;
  private tokens: number;
  private lastRefill: number;
  constructor(ratePerSec: number, burst: number) {
    this.ratePerSec = ratePerSec;
    this.burst = burst;
    this.tokens = burst;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.lastRefill) / 1000) * this.ratePerSec);
    this.lastRefill = now;
  }

  /** Take a token if one is available right now. */
  tryTake(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** How long until the next token matures (0 = one is available now). */
  msUntilAvailable(): number {
    this.refill();
    return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000);
  }
}

/** Wait for (then take) a token. Stack-safe recursive Effect — sleeps exactly until the next
 *  token matures rather than busy-polling. */
export function acquireToken(bucket: TokenBucket): Effect.Effect<void> {
  return Effect.suspend(() =>
    bucket.tryTake()
      ? Effect.void
      : Effect.sleep(Duration.millis(bucket.msUntilAvailable() + 5)).pipe(Effect.flatMap(() => acquireToken(bucket))),
  );
}

/** Retry only what can plausibly succeed on retry: transport failures, timeouts, 429 and 5xx.
 *  4xx (auth, bad request, missing transition) fails fast. */
function isRetryable(e: HttpError): boolean {
  if (e instanceof HttpStatusError) return e.status === 429 || e.status >= 500;
  return true; // timeout / network
}

/** Cap on how long a server-sent Retry-After is honored — a pathological header must not park
 *  a reconcile fiber for minutes. */
const MAX_RETRY_AFTER_MS = 60_000;

export interface HttpPolicy {
  /** Shared per-backend bucket; every attempt (including retries) takes a token. */
  bucket?: TokenBucket;
  /** Extra attempts after the first (default 3). */
  retries?: number;
}

/**
 * The full outbound pipeline: token from the bucket → request → non-2xx as typed failure →
 * retry with exponential backoff + jitter (Schedule) for retryable failures, honoring a 429/503
 * Retry-After by sleeping it BEFORE the schedule's own delay. This is the item-6 seam layered on
 * item 1's timeout-bounded attempts.
 */
export function httpWithPolicy(req: HttpRequest, policy: HttpPolicy = {}, as: "text" | "bytes" = "text"): Effect.Effect<HttpResponse, HttpError> {
  const attempt = (policy.bucket ? acquireToken(policy.bucket) : Effect.void).pipe(
    Effect.flatMap(() => httpExpectOk(req, as)),
    Effect.catchAll((e) =>
      e instanceof HttpStatusError && e.retryAfterMs != null && isRetryable(e)
        ? telemetryEventEffect("http.retry_after_honored", { "url.full": req.url, "http.response.status_code": e.status, "retry_after.ms": e.retryAfterMs }).pipe(
            Effect.flatMap(() => Effect.sleep(Duration.millis(Math.min(e.retryAfterMs!, MAX_RETRY_AFTER_MS)))),
            Effect.flatMap(() => Effect.fail(e)),
          )
        : Effect.fail(e),
    ),
  );
  return attempt.pipe(
    Effect.retry({
      while: isRetryable,
      schedule: Schedule.exponential(Duration.millis(500), 2).pipe(
        Schedule.jittered,
        Schedule.intersect(Schedule.recurs(policy.retries ?? 3)),
      ),
    }),
  );
}

/** Promise convenience for clients that aren't Effect-shaped yet. */
export function httpOk(req: HttpRequest, policy?: HttpPolicy): Promise<HttpResponse> {
  return runEffectPromise(policy ? httpWithPolicy(req, policy) : httpExpectOk(req));
}

/** As httpOk, but the body is returned as raw bytes (attachment downloads). */
export async function httpOkBytes(req: HttpRequest, policy?: HttpPolicy): Promise<HttpResponse & { bytes: Buffer }> {
  const res = await runEffectPromise(policy ? httpWithPolicy(req, policy, "bytes") : httpExpectOk(req, "bytes"));
  return { ...res, bytes: res.bytes! };
}
