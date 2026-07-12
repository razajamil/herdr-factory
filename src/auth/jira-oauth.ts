// The Atlassian OAuth 2.0 (3LO) protocol for Jira Cloud — authorize URL, code↔token exchange,
// refresh, and cloud-resource discovery.
//
// THE CLIENT NEVER HOLDS THE client_secret. Atlassian 3LO requires a confidential-client secret for
// the token exchange (there's no public/PKCE-only mode — a secretless exchange 401s), but shipping a
// secret to every install is unacceptable. So the token exchange + refresh are delegated to a BROKER
// (src/broker/) that holds the client_id + client_secret server-side and forwards to Atlassian; the
// client sends it only the code + PKCE code_verifier (or a refresh_token). Everything else stays
// client-side and needs no secret: the authorize URL (public client_id only) and accessible-resources
// (Bearer with the user's own access token). PKCE is kept end-to-end for defence-in-depth.
//
// The Jira REST API for an OAuth client is https://api.atlassian.com/ex/jira/<cloudId>/... (NOT the
// site host); cloudId comes from accessible-resources after the first token.
import { createHash, randomBytes } from "node:crypto";
import { httpOk } from "../clients/http.ts";
import { recordOAuthEvent, telemetrySpan } from "../telemetry/index.ts";

const AUTHORIZE_URL = "https://auth.atlassian.com/authorize";
/** Atlassian's real token endpoint — used by the BROKER (src/broker), not the client. */
export const ATLASSIAN_TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources";

/** The default port the local OAuth broker listens on, and the client's default broker URL. Override
 *  the client's target with JIRA_OAUTH_BROKER_URL once the broker is hosted elsewhere. */
export const DEFAULT_BROKER_PORT = 9099;
export const DEFAULT_BROKER_URL = `http://127.0.0.1:${DEFAULT_BROKER_PORT}`;

/** The OAuth Jira REST base for a given cloudId. */
export const jiraApiBase = (cloudId: string): string => `https://api.atlassian.com/ex/jira/${cloudId}`;

/** Classic Jira scopes covering the issue-search poll + status transitions + comments (read/write:jira-work),
 *  the whoami session check (read:jira-user → /rest/api/3/myself), plus offline_access (REQUIRED to
 *  receive a refresh_token). Overridable per-source via auth.scopes. */
export const DEFAULT_JIRA_SCOPES = ["read:jira-work", "write:jira-work", "read:jira-user", "offline_access"];

// The built-in public client_id (safe to commit — it rides in the browser URL, grants nothing alone).
// The client_secret is NOT here: it lives only in the broker's env (src/broker), never shipped to a
// client. MAINTAINER app setup: register ONE OAuth 2.0 (3LO) app at developer.atlassian.com — Callback
// URL EXACTLY https://localhost:8976/oauth/callback (console requires https; Jira 3LO matches
// redirect_uri exactly, no RFC 8252 dynamic ports — OAUTH_REDIRECT_URI in jira-login.ts), the Jira API
// with DEFAULT_JIRA_SCOPES, made "Distributed" (Distribution → enable sharing) so non-owner accounts
// can consent. Put the client_id below + client_id/secret in the broker's env.
export const BUILT_IN_CLIENT_ID = "R6XRGNmiNVCxA5gqTADoB0zq7ZXbqLut";

/** What the client needs: the public client_id (for the authorize URL) and the broker URL (for the
 *  secret-bearing token exchange/refresh). No secret here. */
export interface OAuthApp {
  clientId: string;
  brokerUrl: string;
}

/** Resolve the client's OAuth config: the public client_id (override via auth.client_id, else the
 *  baked built-in) and the broker URL (override via JIRA_OAUTH_BROKER_URL, else the local default). */
export function resolveJiraOAuthApp(opts: { clientId?: string; brokerUrl?: string }): OAuthApp {
  const clientId = opts.clientId?.trim() || BUILT_IN_CLIENT_ID;
  const brokerUrl = (opts.brokerUrl?.trim() || DEFAULT_BROKER_URL).replace(/\/+$/, "");
  if (!clientId) {
    throw new Error("no Jira OAuth client_id — set `auth.client_id` in the source config (a public client id from a developer.atlassian.com OAuth app).");
  }
  return { clientId, brokerUrl };
}

/** A fresh PKCE pair: a high-entropy verifier (kept by the client) and its S256 challenge (sent on
 *  /authorize). RFC 7636 — the verifier proves possession at the token exchange in place of a secret. */
export function newPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url"); // 43 chars, within the 43–128 spec range
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null; // present only when offline_access was granted; ROTATES on refresh
  expiresInSec: number;
  scope: string;
}

export function buildAuthorizeUrl(opts: { app: OAuthApp; redirectUri: string; scopes: string[]; state: string; codeChallenge: string }): string {
  const p = new URLSearchParams({
    audience: "api.atlassian.com",
    client_id: opts.app.clientId,
    scope: opts.scopes.join(" "),
    redirect_uri: opts.redirectUri,
    state: opts.state,
    response_type: "code",
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
    prompt: "consent",
  });
  return `${AUTHORIZE_URL}?${p.toString()}`;
}

// The token exchange goes to the BROKER's /oauth/token, NOT Atlassian directly — the broker injects
// client_id + client_secret and forwards. So the client sends only grant params (no secret).
async function postToken(brokerUrl: string, body: Record<string, string>): Promise<TokenSet> {
  const res = await httpOk(
    { url: `${brokerUrl}/oauth/token`, method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) },
    { retries: 2 },
  );
  const j = JSON.parse(res.text) as { access_token: string; refresh_token?: string; expires_in: number; scope: string };
  return { accessToken: j.access_token, refreshToken: j.refresh_token ?? null, expiresInSec: j.expires_in, scope: j.scope };
}

/** A broker token grant wrapped in a semantic OAuth span + an ok/error `oauth_events` counter — the
 *  inner broker HTTP call is separately spanned by httpOk (http.client.backend), so this nests under
 *  `jira.oauth.<phase>` for a clean trace. `phase` distinguishes the first exchange from a refresh. */
function tokenGrant(phase: "token_exchange" | "token_refresh", brokerUrl: string, body: Record<string, string>): Promise<TokenSet> {
  return telemetrySpan("jira.oauth." + phase, { "oauth.phase": phase, "oauth.grant_type": body.grant_type! }, async (span) => {
    try {
      const tokens = await postToken(brokerUrl, body);
      span.setAttribute("oauth.scope", tokens.scope).setAttribute("oauth.refresh_rotated", tokens.refreshToken !== null);
      recordOAuthEvent({ "oauth.phase": phase, "oauth.outcome": "ok", "oauth.grant_type": body.grant_type });
      return tokens;
    } catch (e) {
      span.recordException(e);
      recordOAuthEvent({ "oauth.phase": phase, "oauth.outcome": "error", "oauth.grant_type": body.grant_type });
      throw e;
    }
  });
}

/** Exchange an authorization code (from the callback/paste redirect) for the first token set, via the
 *  broker. PKCE code_verifier is sent; the broker adds the client credentials. */
export function exchangeCode(opts: { app: OAuthApp; code: string; redirectUri: string; codeVerifier: string }): Promise<TokenSet> {
  return tokenGrant("token_exchange", opts.app.brokerUrl, {
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
  });
}

/** Exchange a (rotating) refresh token for a fresh access token, via the broker. */
export function refreshAccessToken(opts: { app: OAuthApp; refreshToken: string }): Promise<TokenSet> {
  return tokenGrant("token_refresh", opts.app.brokerUrl, {
    grant_type: "refresh_token",
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
