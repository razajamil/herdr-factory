// The JiraAuth provider seam: how JiraClient gets its per-request base URL + auth headers, and how it
// recovers from a 401. One implementation — JiraApiTokenAuth (email + API token → Basic auth against
// the site host). Jira is api_token ONLY: pickup goes through the Agile board API (/rest/agile/1.0),
// which is not reachable with an OAuth token, so there is no OAuth provider here.
import type { SourceAuthStatus } from "../core/deps.ts";
import { SourceUnauthenticatedError } from "./errors.ts";

/** The effective request context for one Jira call. */
export interface JiraAuthContext {
  baseUrl: string;
  headers: Record<string, string>;
}

export interface JiraAuth {
  /** Base URL + auth headers for a request. Throws SourceUnauthenticatedError when there are no
   *  usable credentials. */
  authorize(): Promise<JiraAuthContext>;
  /** A request just got 401/403 — try to recover. api_token can't self-heal (returns false → the
   *  caller surfaces a rejected-credential error). */
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
