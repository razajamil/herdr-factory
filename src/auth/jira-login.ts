// The interactive Jira OAuth login flow, driven by the `auth login` CLI command. Two capture modes,
// both authorization-code (Atlassian has no device flow / public PKCE):
//   - loopback (default): spin a one-shot 127.0.0.1 listener, open the browser, catch the redirect.
//   - paste (--paste): print the URL, the operator approves in ANY browser and pastes the redirected
//     URL back — for a headless/remote factory where the browser isn't on this machine.
// On success it discovers the cloudId (accessible-resources) and persists tokens via the store, so
// the running server picks them up on its next authorize() (WAL + fresh reads) — no restart.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Store } from "../db/store.ts";
import { run } from "../clients/exec.ts";
import { accessibleResources, buildAuthorizeUrl, exchangeCode, pickResource, type OAuthApp } from "./jira-oauth.ts";

/** Paste-mode redirect: the browser lands here (nothing listening — the operator copies the URL bar).
 *  Must be a registered/allowed loopback callback on the OAuth app; port 80 default keeps it simple. */
const PASTE_REDIRECT = "http://localhost/oauth/callback";
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
  redirectUri: string;
  /** Resolves with the authorization code once the browser hits the callback (rejects on
   *  error/state-mismatch/timeout). Closing is automatic when it settles. */
  code: Promise<string>;
}

/** Start a one-shot loopback listener on an ephemeral 127.0.0.1 port and hand back the redirect URI
 *  (with that port) plus a promise for the captured code. */
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
    server.once("error", rejectStart);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolveStart({ redirectUri: `http://127.0.0.1:${port}/oauth/callback`, code: codeP });
    });
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
  let code: string;
  let redirectUri: string;

  if (opts.paste) {
    redirectUri = PASTE_REDIRECT;
    const authUrl = buildAuthorizeUrl({ app: opts.app, redirectUri, scopes: opts.scopes, state });
    opts.log(`Open this URL in a browser, approve access, then paste the URL you land on:\n\n  ${authUrl}\n`);
    code = codeFromPaste(await opts.readPastedRedirect(), state);
  } else {
    const lb = await startLoopback(state);
    redirectUri = lb.redirectUri;
    const authUrl = buildAuthorizeUrl({ app: opts.app, redirectUri, scopes: opts.scopes, state });
    opts.log(`Opening your browser to authorize herdr-factory…\n\n  ${authUrl}\n\n(waiting for the redirect; Ctrl-C to cancel — or re-run with --paste on a headless host)`);
    if (!(await openUrl(authUrl))) opts.log("Couldn't open a browser automatically — open the URL above yourself.");
    code = await lb.code;
  }

  const tokens = await exchangeCode({ app: opts.app, code, redirectUri });
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
