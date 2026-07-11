// The Atlassian OAuth 2.0 (3LO) protocol for Jira Cloud — authorize URL, code↔token exchange,
// refresh, and cloud-resource discovery. CONFIDENTIAL CLIENT + PKCE (S256): the token exchange sends
// BOTH a client_secret AND the PKCE code_verifier. Atlassian 3LO has NO usable public-client mode:
// despite /.well-known advertising token_endpoint_auth_methods_supported: ["none", …], the live
// token endpoint 401s a secretless exchange ({"error":"access_denied"}) — verified 2026-07, and a
// known Atlassian issue ("Jira blocks the PKCE request expecting a client secret"). So a secret is
// required; PKCE is kept on top for defence-in-depth. Rides the shared Effect http pipeline.
//
// Endpoints: authorize/token on auth.atlassian.com; the Jira REST API for an OAuth client is
// https://api.atlassian.com/ex/jira/<cloudId>/... (NOT the site host — the big difference from
// api_token). cloudId is discovered from accessible-resources after the first token. There is NO
// dynamic client registration at auth.atlassian.com (registration_endpoint absent) and NO device
// grant, so a pre-registered client_id + secret are the irreducible inputs.
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

// ── The built-in herdr-factory Atlassian OAuth app ─────────────────────────────────────────────
// The client_id is baked (it's public — it rides in the browser URL, grants nothing alone). The
// client_secret is NOT baked by default: Atlassian 3LO requires it, so it's a real secret — leave it
// empty here and supply it per-repo via JIRA_OAUTH_CLIENT_SECRET (env), OR bake it (accepting that a
// committed secret in an OSS repo is effectively public; its blast radius is consent-screen
// impersonation, not data access, since a token still needs the user's Allow + a fresh code).
//
// MAINTAINER: register ONE OAuth 2.0 (3LO) app at developer.atlassian.com — Callback URL EXACTLY
// https://localhost:8976/oauth/callback (the console requires https; Jira 3LO matches redirect_uri
// exactly, port included; no RFC 8252 dynamic ports — this is OAUTH_REDIRECT_URI in jira-login.ts),
// the Jira API enabled with DEFAULT_JIRA_SCOPES, made "Distributed" (Distribution → enable sharing)
// so non-owner accounts can consent. client_id below; client_secret via env (or baked below).
const BUILT_IN_CLIENT_ID = "R6XRGNmiNVCxA5gqTADoB0zq7ZXbqLut"; // public client id (safe to commit)
const BUILT_IN_CLIENT_SECRET = ""; // leave empty → supply via JIRA_OAUTH_CLIENT_SECRET; bake only if you accept the leak

export interface OAuthApp {
  clientId: string;
  clientSecret: string;
}

/** Resolve the OAuth app credentials: per-source/env overrides win over the baked built-ins.
 *  Atlassian 3LO requires the secret (no public/PKCE-only mode), so both are required — the errors
 *  say exactly what to set. */
export function resolveJiraOAuthApp(opts: { clientId?: string; clientSecret?: string }): OAuthApp {
  const clientId = opts.clientId?.trim() || BUILT_IN_CLIENT_ID;
  const clientSecret = opts.clientSecret?.trim() || BUILT_IN_CLIENT_SECRET;
  if (!clientId) {
    throw new Error("no Jira OAuth client_id — set `auth.client_id` in the source config (a public client id from a developer.atlassian.com OAuth app).");
  }
  if (!clientSecret) {
    throw new Error(
      "no Jira OAuth client secret — Atlassian 3LO requires one (there is no public/PKCE-only mode). Copy it from your app's Settings in the developer console and set JIRA_OAUTH_CLIENT_SECRET in the repo env (~/.config/herdr-factory/repos/<name>/env).",
    );
  }
  return { clientId, clientSecret };
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

/** Exchange an authorization code (from the callback/paste redirect) for the first token set —
 *  confidential client (client_secret) + PKCE (code_verifier). */
export function exchangeCode(opts: { app: OAuthApp; code: string; redirectUri: string; codeVerifier: string }): Promise<TokenSet> {
  return postToken({
    grant_type: "authorization_code",
    client_id: opts.app.clientId,
    client_secret: opts.app.clientSecret,
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
  });
}

/** Exchange a (rotating) refresh token for a fresh access token — client_id + client_secret. */
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
