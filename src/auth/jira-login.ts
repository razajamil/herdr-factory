// The interactive Jira OAuth login flow, driven by the `auth login` CLI command. Authorization-code
// + PKCE (public client, no secret). Two capture modes:
//   - loopback (default): spin a one-shot 127.0.0.1 listener on a FIXED port, open the browser, catch
//     the redirect.
//   - paste (--paste): print the URL, the operator approves in ANY browser and pastes the redirected
//     URL back — for a headless/remote factory where the browser isn't on this machine.
// Both use the SAME redirect_uri (OAUTH_REDIRECT_URI). Jira Cloud 3LO matches redirect_uri EXACTLY
// against the app's single registered callback and does NOT honor RFC 8252 dynamic loopback ports
// (JRACLOUD-92180) — hence a pinned port, and the registered callback MUST equal OAUTH_REDIRECT_URI.
// On success it discovers the cloudId (accessible-resources) and persists tokens via the store, so
// the running server picks them up on its next authorize() (WAL + fresh reads) — no restart.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import type { Store } from "../db/store.ts";
import { run } from "../clients/exec.ts";
import { accessibleResources, buildAuthorizeUrl, exchangeCode, newPkcePair, pickResource, type OAuthApp } from "./jira-oauth.ts";

/** The fixed loopback port and the SINGLE callback URL the OAuth app must register. `localhost` (not
 *  127.0.0.1) so the registered string matches what the browser sends; the listener binds 127.0.0.1,
 *  which localhost resolves to. Change both together — and re-register the callback — if 8976 clashes. */
export const OAUTH_LOOPBACK_PORT = 8976;
export const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_LOOPBACK_PORT}/oauth/callback`;
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

const page = (msg: string): string =>
  `<!doctype html><meta charset=utf-8><title>herdr-factory</title><body style="font:16px system-ui;margin:3rem;color:#222"><h2>herdr-factory</h2><p>${msg}</p></body>`;

/** Open a URL in the OS browser. Best-effort — returns false if we couldn't launch one (paste the
 *  URL manually then). */
async function openUrl(url: string): Promise<boolean> {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    await run(cmd, args as string[], { allowFail: true, timeoutMs: 10_000 });
    return true;
  } catch {
    return false;
  }
}

interface Loopback {
  /** Resolves with the authorization code once the browser hits the callback (rejects on
   *  error/state-mismatch/timeout). Closing is automatic when it settles. */
  code: Promise<string>;
}

/** Start a one-shot loopback listener on the FIXED port (matching OAUTH_REDIRECT_URI) and hand back a
 *  promise for the captured code. Rejects with an actionable message if the port is already in use. */
function startLoopback(expectedState: string): Promise<Loopback> {
  return new Promise<Loopback>((resolveStart, rejectStart) => {
    let resolveCode!: (c: string) => void;
    let rejectCode!: (e: Error) => void;
    const codeP = new Promise<string>((rc, jc) => {
      resolveCode = rc;
      rejectCode = jc;
    });
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/oauth/callback") {
        res.writeHead(404).end("not found");
        return;
      }
      const err = url.searchParams.get("error");
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (err) {
        res.writeHead(200, { "content-type": "text/html" }).end(page(`Authorization failed: ${err}. You can close this tab.`));
        rejectCode(new Error(`authorization denied: ${err}`));
      } else if (state !== expectedState) {
        res.writeHead(400, { "content-type": "text/html" }).end(page("State mismatch — please retry the login."));
        rejectCode(new Error("OAuth state mismatch (possible CSRF) — login aborted"));
      } else if (!code) {
        res.writeHead(400, { "content-type": "text/html" }).end(page("No authorization code returned."));
        rejectCode(new Error("no authorization code in the callback"));
      } else {
        res.writeHead(200, { "content-type": "text/html" }).end(page("herdr-factory is now authenticated. You can close this tab."));
        resolveCode(code);
      }
    });
    const timer = setTimeout(() => rejectCode(new Error("timed out waiting for the browser callback (5 min)")), CALLBACK_TIMEOUT_MS);
    void codeP.finally(() => {
      clearTimeout(timer);
      server.close();
    });
    server.once("error", (e: NodeJS.ErrnoException) =>
      rejectStart(
        e.code === "EADDRINUSE"
          ? new Error(`loopback port ${OAUTH_LOOPBACK_PORT} is already in use — free it and retry, or use --paste`)
          : e,
      ),
    );
    server.listen(OAUTH_LOOPBACK_PORT, "127.0.0.1", () => resolveStart({ code: codeP }));
  });
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

/** Run the OAuth login and persist tokens. `readPastedRedirect` is only invoked in paste mode. */
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
  const redirectUri = OAUTH_REDIRECT_URI; // one registered callback, used by both modes
  const authUrl = buildAuthorizeUrl({ app: opts.app, redirectUri, scopes: opts.scopes, state, codeChallenge: challenge });
  let code: string;

  if (opts.paste) {
    opts.log(`Open this URL in a browser, approve access, then paste the URL you land on:\n\n  ${authUrl}\n`);
    code = codeFromPaste(await opts.readPastedRedirect(), state);
  } else {
    const lb = await startLoopback(state);
    opts.log(`Opening your browser to authorize herdr-factory…\n\n  ${authUrl}\n\n(waiting for the redirect; Ctrl-C to cancel — or re-run with --paste on a headless host)`);
    if (!(await openUrl(authUrl))) opts.log("Couldn't open a browser automatically — open the URL above yourself.");
    code = await lb.code;
  }

  const tokens = await exchangeCode({ app: opts.app, code, redirectUri, codeVerifier: verifier });
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
