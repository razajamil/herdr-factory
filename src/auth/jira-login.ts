// The Jira OAuth login flow (authorization-code + PKCE, public client — no secret). The redirect
// lands on the RESIDENT server's https callback listener (server/serve.ts starts it on
// OAUTH_CALLBACK_PORT; server/app.ts serves /oauth/callback), which stashes the code by `state`; the
// caller polls /oauth/callback-result for it (`pollServerForCode`) — no throwaway per-login server.
//
// Atlassian Cloud 3LO forces an https callback and an exact redirect_uri (no RFC 8252 dynamic ports),
// so the listener uses a self-signed cert → the browser shows a one-time "not private" warning the
// operator clicks through. When the server's callback listener isn't available (e.g. no openssl), the
// caller falls back to a paste capture (`codeFromPaste`) instead. This module only assembles the URL,
// exchanges the code, and persists tokens; HOW the code is captured is injected as `getCode`.
import { randomBytes } from "node:crypto";
import type { Store } from "../db/store.ts";
import { run } from "../clients/exec.ts";
import { accessibleResources, buildAuthorizeUrl, exchangeCode, newPkcePair, pickResource, type OAuthApp } from "./jira-oauth.ts";

/** The fixed port the OAuth app's single https callback is registered on, and the redirect_uri we
 *  send (must match the registered callback exactly). The resident server listens here for the
 *  callback; `https` + `localhost` because the console requires https and Jira 3LO matches exactly. */
export const OAUTH_CALLBACK_PORT = 8976;
export const OAUTH_REDIRECT_URI = `https://localhost:${OAUTH_CALLBACK_PORT}/oauth/callback`;

const CAPTURE_TIMEOUT_MS = 5 * 60 * 1000;

/** Open a URL in the OS browser. Best-effort — returns false if we couldn't launch one. */
export async function openBrowser(url: string): Promise<boolean> {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    await run(cmd, args as string[], { allowFail: true, timeoutMs: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Poll the resident server's /oauth/callback-result for the code its https listener captured for
 *  `state`. Resolves with the code, rejects on an authorization error or timeout. */
export async function pollServerForCode(serverPort: number, state: string, opts: { timeoutMs?: number } = {}): Promise<string> {
  const deadline = Date.now() + (opts.timeoutMs ?? CAPTURE_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const res = await fetch(`http://127.0.0.1:${serverPort}/oauth/callback-result?state=${encodeURIComponent(state)}`, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
    if (res?.ok) {
      const j = (await res.json().catch(() => null)) as { status?: string; code?: string; error?: string } | null;
      if (j?.status === "done" && j.code) return j.code;
      if (j?.status === "error") throw new Error(j.error || "authorization failed");
    }
    await new Promise((r) => setTimeout(r, 1_500));
  }
  throw new Error("timed out waiting for the browser callback (5 min)");
}

/** Extract the authorization code from a pasted redirect URL (validating state) or a bare code —
 *  the fallback capture when the server's callback listener isn't available. */
export function codeFromPaste(input: string, expectedState: string): string {
  const t = input.trim();
  if (/^https?:\/\//i.test(t)) {
    const u = new URL(t);
    const err = u.searchParams.get("error");
    if (err) throw new Error(`authorization denied: ${err}`);
    const state = u.searchParams.get("state");
    if (state && state !== expectedState) throw new Error("OAuth state mismatch (possible CSRF) — login aborted");
    const code = u.searchParams.get("code");
    if (!code) throw new Error("no ?code= found in the pasted URL");
    return code;
  }
  if (!t) throw new Error("empty input — paste the redirected URL (or the code)");
  return t; // a bare code (state can't be checked, but the exchange still validates it server-side)
}

export interface JiraLoginResult {
  cloudUrl: string;
  cloudName: string;
  cloudId: string;
  scopes: string;
  expiresAt: number;
}

/** Assemble the authorize URL, capture the code via the injected `getCode`, exchange it (PKCE, no
 *  secret) and persist tokens. `getCode` receives the authorize URL + `state` and returns the code
 *  (server-poll or paste). */
export async function jiraOAuthLogin(opts: {
  store: Store;
  repo: string;
  source: string;
  siteBaseUrl: string;
  app: OAuthApp;
  scopes: string[];
  now: () => number;
  getCode: (ctx: { authUrl: string; state: string }) => Promise<string>;
}): Promise<JiraLoginResult> {
  const state = randomBytes(16).toString("hex");
  const { verifier, challenge } = newPkcePair(); // PKCE — no client_secret; the verifier is the proof
  const authUrl = buildAuthorizeUrl({ app: opts.app, redirectUri: OAUTH_REDIRECT_URI, scopes: opts.scopes, state, codeChallenge: challenge });

  const code = await opts.getCode({ authUrl, state });

  const tokens = await exchangeCode({ app: opts.app, code, redirectUri: OAUTH_REDIRECT_URI, codeVerifier: verifier });
  const resource = pickResource(await accessibleResources(tokens.accessToken), opts.siteBaseUrl);
  const expiresAt = opts.now() + tokens.expiresInSec;
  opts.store.saveSourceAuth({
    repo: opts.repo,
    source: opts.source,
    method: "oauth",
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt,
    cloudId: resource.id,
    cloudUrl: resource.url,
    scopes: tokens.scope,
  });
  return { cloudUrl: resource.url, cloudName: resource.name, cloudId: resource.id, scopes: tokens.scope, expiresAt };
}
