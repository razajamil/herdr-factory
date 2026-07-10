// The interactive Jira OAuth login flow, driven by the `auth login` CLI command. Authorization-code
// + PKCE (public client — no secret).
//
// Atlassian Cloud 3LO forces an HTTPS callback and matches redirect_uri EXACTLY (no RFC 8252 dynamic
// loopback ports — JRACLOUD-92180). Serving HTTPS on localhost would need a self-signed cert (a scary
// browser warning), so rather than auto-catch the redirect we use the copy-the-URL flow: nothing
// listens on the callback, the browser lands on a "can't reach localhost" page (EXPECTED), and the
// operator pastes that address-bar URL back — it carries ?code=…&state=…. Works identically local and
// headless/remote. On success it discovers the cloudId (accessible-resources) and persists tokens via
// the store, so the running server picks them up on its next authorize() (WAL + fresh reads) — no restart.
import { randomBytes } from "node:crypto";
import type { Store } from "../db/store.ts";
import { run } from "../clients/exec.ts";
import { accessibleResources, buildAuthorizeUrl, exchangeCode, newPkcePair, pickResource, type OAuthApp } from "./jira-oauth.ts";

/** The single callback URL the OAuth app must register — https (console requirement) and an exact
 *  match to the redirect_uri we send. Nothing listens here; the browser's failed navigation still
 *  shows the ?code= in its address bar, which the operator pastes back. */
export const OAUTH_REDIRECT_URI = "https://localhost:8976/oauth/callback";

/** Open a URL in the OS browser. Best-effort — returns false if we couldn't launch one. */
async function openUrl(url: string): Promise<boolean> {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    await run(cmd, args as string[], { allowFail: true, timeoutMs: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Extract the authorization code from a pasted redirect URL (validating state) or a bare code. */
function codeFromPaste(input: string, expectedState: string): string {
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

/** Run the OAuth login and persist tokens. Auto-opens a browser unless `paste` (headless), then reads
 *  the redirected URL back via `readPastedRedirect`. */
export async function jiraOAuthLogin(opts: {
  store: Store;
  repo: string;
  source: string;
  siteBaseUrl: string;
  app: OAuthApp;
  scopes: string[];
  paste: boolean;
  now: () => number;
  log: (msg: string) => void;
  readPastedRedirect: () => Promise<string>;
}): Promise<JiraLoginResult> {
  const state = randomBytes(16).toString("hex");
  const { verifier, challenge } = newPkcePair(); // PKCE — no client_secret; the verifier is the proof
  const authUrl = buildAuthorizeUrl({ app: opts.app, redirectUri: OAUTH_REDIRECT_URI, scopes: opts.scopes, state, codeChallenge: challenge });

  if (!opts.paste && (await openUrl(authUrl))) {
    opts.log("A browser is opening to authorize herdr-factory — approve access.");
  } else {
    opts.log(`Open this URL in a browser and approve access:\n\n  ${authUrl}\n`);
  }
  opts.log(
    `Your browser will then show a "can't reach localhost" page — that is EXPECTED (nothing is meant\n` +
      `to be listening). Copy the FULL address-bar URL (it starts with ${OAUTH_REDIRECT_URI}?code=…)\n` +
      `and paste it here.`,
  );
  const code = codeFromPaste(await opts.readPastedRedirect(), state);

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
  if (!tokens.refreshToken) {
    opts.log("Warning: no refresh token was returned — add `offline_access` to the source's `auth.scopes` so the session can renew without re-login.");
  }
  return { cloudUrl: resource.url, cloudName: resource.name, cloudId: resource.id, scopes: tokens.scope, expiresAt };
}
