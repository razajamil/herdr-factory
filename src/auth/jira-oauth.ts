// The Atlassian OAuth 2.0 (3LO) protocol for Jira Cloud — authorize URL, code↔token exchange,
// refresh, and cloud-resource discovery. PUBLIC CLIENT + PKCE (S256): NO client_secret. This is
// what auth.atlassian.com's live metadata advertises (token_endpoint_auth_methods_supported
// includes "none", code_challenge_methods_supported: ["S256"]) — verified 2026-07 against
// /.well-known/oauth-authorization-server. The PKCE code_verifier proves the token request comes
// from the same client that started the flow, so no shared secret is needed or stored. Rides the
// shared Effect http pipeline (clients/http.ts) for timeouts + retry.
//
// Endpoints: authorize/token on auth.atlassian.com; the Jira REST API for an OAuth client is
// https://api.atlassian.com/ex/jira/<cloudId>/... (NOT the site host — the big difference from
// api_token). cloudId is discovered from accessible-resources after the first token. There is NO
// dynamic client registration at auth.atlassian.com (registration_endpoint absent) and NO device
// grant, so a pre-registered client_id is the one irreducible input — but a client_id is a PUBLIC
// identifier (it rides in the browser URL), not a secret.
import { createHash, randomBytes } from "node:crypto";
import { httpOk } from "../clients/http.ts";

const AUTHORIZE_URL = "https://auth.atlassian.com/authorize";
const TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources";

/** The OAuth Jira REST base for a given cloudId. */
export const jiraApiBase = (cloudId: string): string => `https://api.atlassian.com/ex/jira/${cloudId}`;

/** Classic Jira scopes covering the board/agile poll + status transitions + comments, plus
 *  offline_access (REQUIRED to receive a refresh_token). Overridable per-source via auth.scopes. */
export const DEFAULT_JIRA_SCOPES = ["read:jira-work", "write:jira-work", "offline_access"];

// ── The built-in herdr-factory Atlassian OAuth app (a PUBLIC client — client_id only) ──────────
// SHIPPED so `auth login` is zero-setup (the operator registers nothing). Because the flow is PKCE
// public-client, only a client_id is baked here — and a client_id is NOT a secret (it appears in
// the browser's address bar during consent and grants nothing on its own). So it's safe in an open
// repo; there is no secret to leak. An operator can point at their own app with auth.client_id.
//
// MAINTAINER: register ONE OAuth 2.0 (3LO) app at developer.atlassian.com — callback
// http://localhost/oauth/callback (loopback; Atlassian honors RFC 8252 any-port at request time),
// the Jira API enabled with DEFAULT_JIRA_SCOPES, configured to allow PKCE / a public client — and
// paste ONLY its client_id below (the secret the console shows is never used). Until then the
// built-in id is empty and `auth login` requires auth.client_id in config.
const BUILT_IN_CLIENT_ID = ""; // TODO(maintainer): the registered app's PUBLIC client id (no secret)

export interface OAuthApp {
  clientId: string;
}

/** Resolve the OAuth app's public client_id: a per-source override (auth.client_id) wins over the
 *  shipped built-in id. Throws with an actionable message when neither is set. No secret involved. */
export function resolveJiraOAuthApp(opts: { clientId?: string }): OAuthApp {
  const clientId = opts.clientId?.trim() || BUILT_IN_CLIENT_ID;
  if (!clientId) {
    throw new Error(
      "no Jira OAuth client_id available — the built-in app isn't configured in this build. Set `auth.client_id` in the source config (a public client id from a developer.atlassian.com OAuth app; no secret needed).",
    );
  }
  return { clientId };
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

async function postToken(body: Record<string, string>): Promise<TokenSet> {
  const res = await httpOk(
    { url: TOKEN_URL, method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) },
    { retries: 2 },
  );
  const j = JSON.parse(res.text) as { access_token: string; refresh_token?: string; expires_in: number; scope: string };
  return { accessToken: j.access_token, refreshToken: j.refresh_token ?? null, expiresInSec: j.expires_in, scope: j.scope };
}

/** Exchange an authorization code (from the loopback/paste redirect) for the first token set. The
 *  PKCE `code_verifier` authenticates the public client — no client_secret. */
export function exchangeCode(opts: { app: OAuthApp; code: string; redirectUri: string; codeVerifier: string }): Promise<TokenSet> {
  return postToken({
    grant_type: "authorization_code",
    client_id: opts.app.clientId,
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
  });
}

/** Exchange a (rotating) refresh token for a fresh access token. Public client: client_id only,
 *  no secret (the refresh_token itself is the credential). */
export function refreshAccessToken(opts: { app: OAuthApp; refreshToken: string }): Promise<TokenSet> {
  return postToken({
    grant_type: "refresh_token",
    client_id: opts.app.clientId,
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
