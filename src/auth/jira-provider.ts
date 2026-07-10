// The JiraAuth provider seam: how JiraClient gets its per-request base URL + auth headers, and how
// it recovers from a 401. Two implementations, selected by the descriptor from auth.method:
//   - JiraApiTokenAuth: email + API token → Basic auth against the site host (today's behavior).
//   - JiraOAuthAuth:    stored OAuth tokens → Bearer against api.atlassian.com/ex/jira/<cloudId>,
//                       refreshed proactively (near expiry) and reactively (on a 401), single-flight.
// Both report a cheap, no-network status() for the auth gate (INV-12). This is the seam Phase 2
// added; a future non-Jira OAuth source would grow its own analogue (or we generalize this one).
import type { Store } from "../db/store.ts";
import type { SourceAuthStatus } from "../core/deps.ts";
import { systemClock } from "../types.ts";
import { SourceUnauthenticatedError } from "./errors.ts";
import { jiraApiBase, refreshAccessToken, type OAuthApp } from "./jira-oauth.ts";

/** The effective request context for one Jira call. */
export interface JiraAuthContext {
  baseUrl: string;
  headers: Record<string, string>;
}

export interface JiraAuth {
  /** Base URL + auth headers for a request, refreshing an OAuth token proactively if near expiry.
   *  Throws SourceUnauthenticatedError when there are no usable credentials. */
  authorize(): Promise<JiraAuthContext>;
  /** A request just got 401/403 — try to recover. OAuth force-refreshes once (returns true → retry);
   *  api_token can't self-heal (returns false → the caller surfaces a rejected-credential error). */
  reauthorize(): Promise<boolean>;
  /** Cheap, no-network local readiness for the auth gate + doctor. */
  status(): SourceAuthStatus;
}

export class JiraApiTokenAuth implements JiraAuth {
  private readonly baseUrl: string;
  private readonly email: string;
  private readonly token: string;
  constructor(baseUrl: string, email: string, token: string) {
    this.baseUrl = baseUrl;
    this.email = email;
    this.token = token;
  }
  async authorize(): Promise<JiraAuthContext> {
    if (!this.email || !this.token) {
      throw new SourceUnauthenticatedError({ reason: "missing", hint: "set JIRA_EMAIL + JIRA_API_TOKEN in the repo env" });
    }
    return { baseUrl: this.baseUrl, headers: { Authorization: `Basic ${Buffer.from(`${this.email}:${this.token}`).toString("base64")}` } };
  }
  async reauthorize(): Promise<boolean> {
    return false; // a rejected api token can't rotate itself — the operator must fix the env
  }
  status(): SourceAuthStatus {
    return this.email && this.token ? { state: "ok" } : { state: "unauthenticated", detail: "set JIRA_EMAIL + JIRA_API_TOKEN in the repo env" };
  }
}

/** Refresh the access token this many seconds BEFORE it expires (proactive, so an in-flight tick
 *  rarely trips a 401). */
const EXPIRY_SKEW_SEC = 60;

export class JiraOAuthAuth implements JiraAuth {
  private readonly store: Store;
  private readonly repo: string;
  private readonly source: string;
  /** Resolves the OAuth app (built-in, or the per-source override) LAZILY — only a refresh/login
   *  needs it, so an oauth source that isn't logged in yet still constructs at startup (it just
   *  reports unauthenticated). Throws when no app is available. */
  private readonly resolveApp: () => OAuthApp;
  private readonly now: () => number;
  /** Single-flight guard: concurrent authorize() calls (reconcile runs runs in parallel) share ONE
   *  refresh, so a rotating refresh_token isn't spent by racing callers that then invalidate it. */
  private refreshing: Promise<void> | null = null;

  constructor(opts: { store: Store; repo: string; source: string; resolveApp: () => OAuthApp; now?: () => number }) {
    this.store = opts.store;
    this.repo = opts.repo;
    this.source = opts.source;
    this.resolveApp = opts.resolveApp;
    this.now = opts.now ?? systemClock;
  }

  private loginHint(): string {
    return `run \`herdr-factory --repo ${this.repo} auth login --source ${this.source}\``;
  }

  async authorize(): Promise<JiraAuthContext> {
    const tok = this.store.getSourceAuth(this.repo, this.source);
    if (!tok || !tok.accessToken || !tok.cloudId) {
      throw new SourceUnauthenticatedError({ reason: "missing", hint: `Jira OAuth: not logged in — ${this.loginHint()}` });
    }
    if (tok.expiresAt != null && this.now() >= tok.expiresAt - EXPIRY_SKEW_SEC) {
      await this.refreshOnce();
    }
    const fresh = this.store.getSourceAuth(this.repo, this.source);
    if (!fresh?.accessToken || !fresh.cloudId) {
      throw new SourceUnauthenticatedError({ reason: "rejected", hint: `Jira OAuth: token unusable after refresh — ${this.loginHint()}` });
    }
    return { baseUrl: jiraApiBase(fresh.cloudId), headers: { Authorization: `Bearer ${fresh.accessToken}` } };
  }

  async reauthorize(): Promise<boolean> {
    const tok = this.store.getSourceAuth(this.repo, this.source);
    if (!tok?.refreshToken) return false;
    try {
      await this.refreshOnce();
      return true;
    } catch {
      return false; // refresh itself failed — surface the original 401 as a rejected credential
    }
  }

  status(): SourceAuthStatus {
    const tok = this.store.getSourceAuth(this.repo, this.source);
    if (!tok?.accessToken || !tok.cloudId) return { state: "unauthenticated", detail: `Jira OAuth: not logged in — ${this.loginHint()}` };
    return { state: "ok" };
  }

  private refreshOnce(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.refresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async refresh(): Promise<void> {
    const tok = this.store.getSourceAuth(this.repo, this.source);
    if (!tok?.refreshToken) {
      throw new SourceUnauthenticatedError({ reason: "missing", hint: `Jira OAuth: no refresh token — ${this.loginHint()}` });
    }
    let app: OAuthApp;
    try {
      app = this.resolveApp();
    } catch (e) {
      throw new SourceUnauthenticatedError({ reason: "missing", hint: e instanceof Error ? e.message : String(e), cause: e });
    }
    let ts;
    try {
      ts = await refreshAccessToken({ app, refreshToken: tok.refreshToken });
    } catch (e) {
      throw new SourceUnauthenticatedError({ reason: "rejected", hint: `Jira OAuth refresh failed — ${this.loginHint()}`, cause: e });
    }
    this.store.saveSourceAuth({
      repo: this.repo,
      source: this.source,
      method: "oauth",
      accessToken: ts.accessToken,
      refreshToken: ts.refreshToken ?? tok.refreshToken, // keep the prior token if the response omits one
      expiresAt: this.now() + ts.expiresInSec,
      cloudId: tok.cloudId,
      cloudUrl: tok.cloudUrl,
      scopes: ts.scope || tok.scopes,
    });
  }
}
