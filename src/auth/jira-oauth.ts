// The Atlassian OAuth 2.0 (3LO) protocol for Jira Cloud — authorize URL, code↔token exchange,
// refresh, and cloud-resource discovery. Authorization-code grant with a client_secret (Atlassian
// exposes NO public PKCE — verified 2026-07), so a confidential client is required. Rides the shared
// Effect http pipeline (clients/http.ts) for timeouts + retry, same as every other backend call.
//
// Endpoints: authorize/token on auth.atlassian.com; the Jira REST API for an OAuth client is
// https://api.atlassian.com/ex/jira/<cloudId>/... (NOT the site host — that's the big difference
// from api_token). cloudId is discovered from accessible-resources after the first token.
import { httpOk } from "../clients/http.ts";

const AUTHORIZE_URL = "https://auth.atlassian.com/authorize";
const TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources";

/** The OAuth Jira REST base for a given cloudId. */
export const jiraApiBase = (cloudId: string): string => `https://api.atlassian.com/ex/jira/${cloudId}`;

/** Classic Jira scopes covering the board/agile poll + status transitions + comments, plus
 *  offline_access (REQUIRED to receive a refresh_token). Overridable per-source via auth.scopes. */
export const DEFAULT_JIRA_SCOPES = ["read:jira-work", "write:jira-work", "offline_access"];

// ── The built-in herdr-factory Atlassian OAuth app ────────────────────────────────────────────
// SHIPPED so `auth login` is zero-setup (the operator registers nothing) — the gh-CLI experience.
// Atlassian 3LO has no public PKCE, so a client_secret is required and would ship here; it is
// therefore NOT truly secret in an open repo (documented tradeoff — the blast radius is
// consent-screen impersonation, not data access, since a token still needs the user's explicit
// Allow + a fresh authorization code). Any operator who prefers not to trust the shipped secret
// overrides it per-source with auth.client_id (config) + JIRA_OAUTH_CLIENT_SECRET (env).
//
// MAINTAINER: register ONE OAuth 2.0 (3LO) app at developer.atlassian.com — callback
// http://localhost/oauth/callback (loopback; Atlassian honors RFC 8252 any-port at request time),
// the Jira API enabled with DEFAULT_JIRA_SCOPES — and paste its credentials below. Until then the
// built-in app is empty and `auth login` requires the per-source override above.
const BUILT_IN_CLIENT_ID = ""; // TODO(maintainer): the registered app's client id
const BUILT_IN_CLIENT_SECRET = ""; // TODO(maintainer): the registered app's client secret

export interface OAuthApp {
  clientId: string;
  clientSecret: string;
}

/** Resolve the OAuth app: a per-source override (config client_id + env secret) wins over the
 *  shipped built-in app. Throws with an actionable message when neither is available. */
export function resolveJiraOAuthApp(opts: { clientId?: string; clientSecret?: string }): OAuthApp {
  const clientId = opts.clientId?.trim() || BUILT_IN_CLIENT_ID;
  const clientSecret = opts.clientSecret?.trim() || BUILT_IN_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "no Jira OAuth app available — the built-in app isn't configured in this build. Set `auth.client_id` in config + JIRA_OAUTH_CLIENT_SECRET in the repo env to use your own registered Atlassian app.",
    );
  }
  return { clientId, clientSecret };
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null; // present only when offline_access was granted; ROTATES on refresh
  expiresInSec: number;
  scope: string;
}

export function buildAuthorizeUrl(opts: { app: OAuthApp; redirectUri: string; scopes: string[]; state: string }): string {
  const p = new URLSearchParams({
    audience: "api.atlassian.com",
    client_id: opts.app.clientId,
    scope: opts.scopes.join(" "),
    redirect_uri: opts.redirectUri,
    state: opts.state,
    response_type: "code",
    prompt: "consent",
  });
  return `${AUTHORIZE_URL}?${p.toString()}`;
}

async function postToken(body: Record<string, string>): Promise<TokenSet> {
  const res = await httpOk(
    { url: TOKEN_URL, method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) },
    { retries: 2 },
  );
  const j = JSON.parse(res.text) as { access_token: string; refresh_token?: string; expires_in: number; scope: string };
  return { accessToken: j.access_token, refreshToken: j.refresh_token ?? null, expiresInSec: j.expires_in, scope: j.scope };
}

/** Exchange an authorization code (from the loopback/paste redirect) for the first token set. */
export function exchangeCode(opts: { app: OAuthApp; code: string; redirectUri: string }): Promise<TokenSet> {
  return postToken({
    grant_type: "authorization_code",
    client_id: opts.app.clientId,
    client_secret: opts.app.clientSecret,
    code: opts.code,
    redirect_uri: opts.redirectUri,
  });
}

/** Exchange a (rotating) refresh token for a fresh access token. */
export function refreshAccessToken(opts: { app: OAuthApp; refreshToken: string }): Promise<TokenSet> {
  return postToken({
    grant_type: "refresh_token",
    client_id: opts.app.clientId,
    client_secret: opts.app.clientSecret,
    refresh_token: opts.refreshToken,
  });
}

export interface AccessibleResource {
  id: string; // the cloudId
  url: string; // the site base, e.g. https://acme.atlassian.net
  name: string;
  scopes: string[];
}

/** The Atlassian sites this token can reach — the cloudId lives here, not in the token response. */
export async function accessibleResources(accessToken: string): Promise<AccessibleResource[]> {
  const res = await httpOk({ url: RESOURCES_URL, headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  return JSON.parse(res.text) as AccessibleResource[];
}

/** Pick the cloud resource matching the configured site base_url; fall back to the sole resource
 *  when the account can reach exactly one. Throws (actionably) on an ambiguous mismatch. */
export function pickResource(resources: AccessibleResource[], siteBaseUrl: string): AccessibleResource {
  const norm = (u: string) => u.replace(/\/+$/, "").toLowerCase();
  const match = resources.find((r) => norm(r.url) === norm(siteBaseUrl));
  if (match) return match;
  if (resources.length === 1) return resources[0]!;
  const urls = resources.map((r) => r.url).join(", ") || "(none)";
  throw new Error(`Jira OAuth: the authorized account can reach [${urls}] but none matches jira.base_url ${siteBaseUrl} — fix base_url or grant the app access to that site`);
}
