// The low-level Sentry REST client (SaaS or self-hosted) over clients/http.ts. Auth is a single
// Bearer token (an org Internal-Integration token or a personal `sntryu_` token) — there is NO
// OAuth here. All calls share one token bucket and the Retry-After-honoring retry policy with hard
// timeouts, so a black-holed Sentry connection can never wedge a reconcile tick.
//
// Sentry warns that polling the REST API "is likely to quickly trigger rate limiting", so the
// bucket is deliberately conservative and a source using this client should also raise its
// `poll_interval_seconds` on a busy org. 429s carry X-Sentry-Rate-Limit-Reset (not a standard
// Retry-After); we don't parse that header — the bucket keeps us under budget proactively and the
// http pipeline exponential-backs-off the rare 429 it still sees.
import type { Logger, SourceAuthStatus } from "../core/deps.ts";
import { SourceUnauthenticatedError } from "../auth/errors.ts";
import { HttpStatusError, httpOk, TokenBucket, type HttpResponse } from "./http.ts";

/** Time budget for a Sentry JSON round-trip — a HARD bound (a hung Sentry must never wedge a tick). */
const SENTRY_TIMEOUT_MS = 30_000;
// Conservative client-side ceiling: Sentry's own docs flag REST polling as a fast route to 429s.
const SENTRY_RATE_PER_SEC = 3;
const SENTRY_BURST = 6;

/** A Sentry issue ("group") as returned by the list/detail endpoints. Only the fields we read are
 *  typed; the raw object is preserved for `MatchItem.fields` + the `issue.json` sidecar. NB: `count`
 *  comes back as a STRING (e.g. "150"). */
export interface SentryIssue {
  id: string;
  shortId?: string | null;
  title?: string;
  culprit?: string | null;
  level?: string | null;
  status?: string; // unresolved | resolved | ignored (muted)
  substatus?: string | null;
  permalink?: string | null;
  count?: string | number | null;
  userCount?: number | null;
  firstSeen?: string | null;
  lastSeen?: string | null;
  isUnhandled?: boolean;
  platform?: string | null;
  type?: string | null;
  issueCategory?: string | null;
  metadata?: { type?: string; value?: string; filename?: string; function?: string; title?: string } | null;
  // The release an issue was first/last seen on. Present on the issue DETAIL endpoint (getIssue);
  // the org issues LIST endpoint does not include it, so a list-payload read degrades to null.
  firstRelease?: { version?: string | null } | null;
  lastRelease?: { version?: string | null } | null;
  project?: { id?: string; slug?: string; name?: string; platform?: string } | null;
  assignedTo?: { type?: string; id?: string; name?: string; email?: string } | null;
  [k: string]: unknown;
}

/** A full Sentry event — the latest one for an issue carries the stacktrace/breadcrumbs/request an
 *  agent needs to fix the bug. `entries` is the structured payload (discriminated by `type`). */
export interface SentryEvent {
  eventID?: string;
  id?: string;
  message?: string | null;
  title?: string | null;
  culprit?: string | null;
  platform?: string | null;
  dateCreated?: string | null;
  tags?: { key: string; value: string }[];
  entries?: { type: string; data: unknown }[];
  contexts?: Record<string, unknown>;
  [k: string]: unknown;
}

/** A Sentry issue note (activity type "note"). `data.text` is the comment body. */
export interface SentryNote {
  id: string;
  dateCreated?: string;
  type?: string;
  user?: { id?: string; name?: string; email?: string; username?: string } | null;
  data?: { text?: string } | null;
}

/** Map a Sentry 401/403 to the typed auth error (else pass the error through unchanged). 401 = the
 *  token is missing/expired/wrong; 403 = the token is valid but lacks the scope (event:read for
 *  reads, event:write for comments/updates) — both are "fix your credentials", surfaced actionably. */
function asSentryAuthError(e: unknown): unknown {
  if (e instanceof HttpStatusError && (e.status === 401 || e.status === 403)) {
    return new SourceUnauthenticatedError({
      reason: "rejected",
      hint:
        `Sentry rejected the token (HTTP ${e.status}) — ` +
        (e.status === 403
          ? "the token lacks the required scope (event:read to poll, event:write to comment/update). Recreate SENTRY_AUTH_TOKEN with Issue & Event read+write."
          : "check SENTRY_AUTH_TOKEN in the repo env (an Internal Integration or personal token)."),
      cause: e,
    });
  }
  return e;
}

/** True when an error is a Sentry "the item is gone" — a deleted/merged-away issue answers 404. */
export function isSentryNotFound(e: unknown): boolean {
  return e instanceof HttpStatusError && (e.status === 404 || e.status === 410);
}

const enc = encodeURIComponent;

export class SentryClient {
  private readonly apiBase: string; // `${baseUrl}/api/0`
  private readonly org: string;
  private readonly token: string;
  private readonly log: Logger;
  private readonly bucket = new TokenBucket(SENTRY_RATE_PER_SEC, SENTRY_BURST);
  private readonly projectIds = new Map<string, string>(); // configured project slug -> numeric id (cached)

  constructor(opts: { baseUrl: string; organization: string; token: string; log?: Logger }) {
    this.apiBase = `${opts.baseUrl.replace(/\/+$/, "")}/api/0`;
    this.org = opts.organization;
    this.token = opts.token;
    this.log = opts.log ?? (() => {});
  }

  /** Cheap, no-network local readiness (INV-12): is a token even present? A present-but-rejected
   *  token still reads "ok" here — a live 401/403 surfaces it via asSentryAuthError. */
  authStatus(): SourceAuthStatus {
    return this.token
      ? { state: "ok" }
      : { state: "unauthenticated", detail: "set SENTRY_AUTH_TOKEN in the repo env" };
  }

  private authHeaders(): Record<string, string> {
    if (!this.token) {
      throw new SourceUnauthenticatedError({
        reason: "missing",
        hint: "set SENTRY_AUTH_TOKEN in the repo env (a Sentry Internal Integration or personal token with event:read + event:write)",
      });
    }
    return { Authorization: `Bearer ${this.token}`, Accept: "application/json" };
  }

  /** One authorized request. Writes (POST/PUT) retry at most once — a 429 was definitively not
   *  processed, and a rare duplicate beats a retry storm of mutations. */
  private async request(path: string, init: { method?: string; body?: unknown; retries?: number }): Promise<HttpResponse> {
    try {
      return await httpOk(
        {
          url: this.apiBase + path,
          method: init.method,
          headers: { ...this.authHeaders(), ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
          timeoutMs: SENTRY_TIMEOUT_MS,
        },
        { bucket: this.bucket, retries: init.retries ?? 3 },
      );
    } catch (e) {
      throw asSentryAuthError(e);
    }
  }

  private async getJson<T>(path: string): Promise<T> {
    return JSON.parse((await this.request(path, {})).text) as T;
  }

  private commonListParams(opts: { environment?: string[]; query?: string; statsPeriod?: string; limit?: number }): URLSearchParams {
    const p = new URLSearchParams();
    if (opts.query != null) p.set("query", opts.query);
    if (opts.statsPeriod) p.set("statsPeriod", opts.statsPeriod);
    p.set("limit", String(opts.limit ?? 100));
    for (const env of opts.environment ?? []) p.append("environment", env);
    return p;
  }

  /**
   * A bounded page of issues matching the filter, always via the ORG endpoint (Sentry's recommended
   * multi-project poll path). Configured project SLUGS are resolved to numeric ids (cached) and passed
   * as `project=<id>`; with no projects we pass `project=-1` for every accessible project. The org
   * endpoint accepts an arbitrary `statsPeriod`, whereas the project-scoped endpoint 400s on anything
   * but 24h/14d — so routing through the org endpoint is what lets `stats_period` be flexible. One page
   * suffices for eligibility — claims are admission-capped per tick and already-claimed items are
   * filtered out downstream.
   */
  async listIssues(opts: { projects?: string[]; environment?: string[]; query?: string; statsPeriod?: string; limit?: number }): Promise<SentryIssue[]> {
    const p = this.commonListParams(opts);
    if (opts.projects && opts.projects.length) {
      const ids = await this.resolveProjectIds(opts.projects);
      if (!ids.length) return []; // every configured project was unresolvable (health surfaces why)
      for (const id of ids) p.append("project", id);
    } else {
      p.append("project", "-1");
    }
    return this.getJson<SentryIssue[]>(`/organizations/${enc(this.org)}/issues/?${p.toString()}`);
  }

  /** Resolve project slugs to their numeric ids (cached per client — one lookup per project ever). A
   *  missing project (404) is skipped with a warning so one bad slug can't wedge the whole poll; auth
   *  (401/403) and transient errors propagate (the auth gate / retry own those). */
  private async resolveProjectIds(slugs: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const slug of slugs) {
      let id = this.projectIds.get(slug);
      if (!id) {
        try {
          id = (await this.getProject(slug)).id;
        } catch (e) {
          if (isSentryNotFound(e)) {
            this.log("warn", `sentry: project "${slug}" not found in ${this.org} — skipping it this poll`);
            continue;
          }
          throw e;
        }
        if (id) this.projectIds.set(slug, id);
      }
      if (id) ids.push(id);
    }
    return ids;
  }

  /** One issue by numeric id. Throws HttpStatusError(404) when it's gone (see isSentryNotFound). */
  async getIssue(issueId: string): Promise<SentryIssue> {
    return this.getJson<SentryIssue>(`/organizations/${enc(this.org)}/issues/${enc(issueId)}/`);
  }

  /** The latest event for an issue — the stacktrace/breadcrumbs/request source. Best-effort: returns
   *  null when there is no resolvable event (a brand-new issue mid-ingest can 404 here). */
  async getLatestEvent(issueId: string, environment?: string[]): Promise<SentryEvent | null> {
    const p = new URLSearchParams();
    for (const env of environment ?? []) p.append("environment", env);
    const qs = p.toString();
    try {
      return await this.getJson<SentryEvent>(`/organizations/${enc(this.org)}/issues/${enc(issueId)}/events/latest/${qs ? `?${qs}` : ""}`);
    } catch (e) {
      if (isSentryNotFound(e)) return null;
      throw e;
    }
  }

  /** Resolve a human short id (e.g. "BACKEND-1AB") to its numeric issue id; null when unknown. */
  async resolveShortId(shortId: string): Promise<{ id: string; shortId: string } | null> {
    try {
      const r = await this.getJson<{ shortId: string; groupId: string }>(`/organizations/${enc(this.org)}/shortids/${enc(shortId)}/`);
      return { id: r.groupId, shortId: r.shortId };
    } catch (e) {
      if (isSentryNotFound(e)) return null;
      throw e;
    }
  }

  /** Notes (comments) on an issue, newest-first (the endpoint's default order). */
  async listComments(issueId: string): Promise<SentryNote[]> {
    return this.getJson<SentryNote[]>(`/organizations/${enc(this.org)}/issues/${enc(issueId)}/comments/`);
  }

  /** Post a note. Sentry rejects an identical note by the same user within 1h with 400 — callers
   *  that must not double-post (askHuman) scan for their marker first; best-effort callers swallow it. */
  async addComment(issueId: string, text: string): Promise<SentryNote> {
    return JSON.parse(
      (await this.request(`/organizations/${enc(this.org)}/issues/${enc(issueId)}/comments/`, { method: "POST", body: { text }, retries: 1 })).text,
    ) as SentryNote;
  }

  /** Update an issue's lifecycle (status / statusDetails / assignedTo …). Used only when a source
   *  opts into a Sentry-side write-back (on_merge: resolve / resolve_in_next_release). */
  async updateIssue(issueId: string, body: Record<string, unknown>): Promise<void> {
    await this.request(`/organizations/${enc(this.org)}/issues/${enc(issueId)}/`, { method: "PUT", body, retries: 1 });
  }

  /** Verify the org is reachable + the token is accepted (the doctor's connectivity probe). */
  async getOrganization(): Promise<{ slug: string }> {
    return this.getJson<{ slug: string }>(`/organizations/${enc(this.org)}/`);
  }

  /** Fetch a project — verifies existence/reachability for health(), and resolveProjectIds reads
   *  its numeric `id` to filter the org issues endpoint. */
  async getProject(project: string): Promise<{ id: string; slug: string }> {
    return this.getJson<{ id: string; slug: string }>(`/projects/${enc(this.org)}/${enc(project)}/`);
  }
}
