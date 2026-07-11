// The JiraAuth providers (src/auth/jira-provider.ts): the api_token Basic path and the OAuth path's
// proactive/reactive refresh, single-flight, and token rotation — the trickiest Phase 2 logic. The
// token endpoint is exercised through a fetch stub (refreshAccessToken → httpOk → fetch).
import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "../src/db/index.ts";
import { Store } from "../src/db/store.ts";
import { JiraApiTokenAuth, JiraOAuthAuth } from "../src/auth/jira-provider.ts";
import { isSourceUnauthenticated } from "../src/auth/errors.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const APP = { clientId: "cid", clientSecret: "sec" }; // confidential client (Atlassian 3LO requires the secret) + PKCE
const makeStore = (now = 1000) => new Store(openDb(":memory:"), () => now);
const seed = (store: Store, over: Partial<{ accessToken: string; refreshToken: string | null; expiresAt: number }> = {}) =>
  store.saveSourceAuth({ repo: "r", source: "jira", method: "oauth", accessToken: "OLD", refreshToken: "RT1", expiresAt: 999_999, cloudId: "CID", cloudUrl: "https://x.atlassian.net", scopes: "s", ...over });

/** Stub the Atlassian token endpoint; returns the parsed request bodies + a call counter. */
function stubToken(response: Record<string, unknown>, opts: { status?: number; delayMs?: number } = {}) {
  const bodies: Record<string, string>[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (String(url) !== "https://auth.atlassian.com/oauth/token") throw new Error(`unexpected fetch: ${url}`);
    bodies.push(JSON.parse(String(init?.body)));
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const status = opts.status ?? 200;
    return { ok: status < 300, status, text: async () => JSON.stringify(response), headers: new Headers() } as Response;
  }) as typeof fetch;
  return bodies;
}

const rejection = async (p: Promise<unknown>): Promise<unknown> => p.then((v) => v, (e) => e);

describe("JiraApiTokenAuth", () => {
  it("authorizes with Basic auth against the site base; missing creds throw; can't self-heal", async () => {
    const ok = new JiraApiTokenAuth("https://x.atlassian.net", "me@x", "tok");
    const ctx = await ok.authorize();
    expect(ctx.baseUrl).toBe("https://x.atlassian.net");
    expect(ctx.headers.Authorization).toBe(`Basic ${Buffer.from("me@x:tok").toString("base64")}`);
    expect(await ok.reauthorize()).toBe(false);
    expect(ok.status().state).toBe("ok");

    const missing = new JiraApiTokenAuth("https://x.atlassian.net", "", "");
    expect(missing.status().state).toBe("unauthenticated");
    expect(isSourceUnauthenticated(await rejection(missing.authorize()))).toBe(true);
  });
});

describe("JiraOAuthAuth", () => {
  it("reports unauthenticated + throws when not logged in", async () => {
    const a = new JiraOAuthAuth({ store: makeStore(), repo: "r", source: "jira", resolveApp: () => APP });
    expect(a.status().state).toBe("unauthenticated");
    expect(isSourceUnauthenticated(await rejection(a.authorize()))).toBe(true);
  });

  it("authorizes a valid token as Bearer against the api.atlassian.com/ex/jira/<cloudId> base", async () => {
    const store = makeStore(1000);
    seed(store);
    const a = new JiraOAuthAuth({ store, repo: "r", source: "jira", resolveApp: () => APP, now: () => 1000 });
    const ctx = await a.authorize();
    expect(ctx.baseUrl).toBe("https://api.atlassian.com/ex/jira/CID");
    expect(ctx.headers.Authorization).toBe("Bearer OLD");
  });

  it("proactively refreshes a near-expiry token and persists the ROTATED refresh token", async () => {
    const store = makeStore(1000);
    seed(store, { expiresAt: 1030 }); // within the 60s skew of now=1000
    const bodies = stubToken({ access_token: "NEW", refresh_token: "RT2", expires_in: 3600, scope: "s" });
    const a = new JiraOAuthAuth({ store, repo: "r", source: "jira", resolveApp: () => APP, now: () => 1000 });
    const ctx = await a.authorize();
    expect(ctx.headers.Authorization).toBe("Bearer NEW");
    expect(bodies[0]).toMatchObject({ grant_type: "refresh_token", refresh_token: "RT1", client_id: "cid", client_secret: "sec" });
    const saved = store.getSourceAuth("r", "jira")!;
    expect([saved.accessToken, saved.refreshToken, saved.expiresAt]).toEqual(["NEW", "RT2", 1000 + 3600]);
  });

  it("single-flights concurrent authorize() refreshes into ONE token call", async () => {
    const store = makeStore(1000);
    seed(store, { expiresAt: 1030 });
    const bodies = stubToken({ access_token: "NEW", refresh_token: "RT2", expires_in: 3600, scope: "s" }, { delayMs: 10 });
    const a = new JiraOAuthAuth({ store, repo: "r", source: "jira", resolveApp: () => APP, now: () => 1000 });
    const ctxs = await Promise.all([a.authorize(), a.authorize(), a.authorize()]);
    expect(bodies.length).toBe(1); // three racing authorizes shared one rotating-refresh call
    for (const c of ctxs) expect(c.headers.Authorization).toBe("Bearer NEW");
  });

  it("reauthorize refreshes once (true); a rejected refresh returns false (surface the 401)", async () => {
    const store = makeStore(1000);
    seed(store);
    stubToken({ access_token: "NEW", refresh_token: "RT2", expires_in: 3600, scope: "s" });
    const a = new JiraOAuthAuth({ store, repo: "r", source: "jira", resolveApp: () => APP, now: () => 1000 });
    expect(await a.reauthorize()).toBe(true);
    expect(store.getSourceAuth("r", "jira")!.accessToken).toBe("NEW");

    stubToken({ error: "invalid_grant" }, { status: 400 }); // refresh token revoked/expired
    expect(await a.reauthorize()).toBe(false);
  });

  it("a resolveApp that throws (no OAuth app) surfaces as an unauthenticated error, not a crash", async () => {
    const store = makeStore(1000);
    seed(store, { expiresAt: 1030 });
    const a = new JiraOAuthAuth({
      store,
      repo: "r",
      source: "jira",
      resolveApp: () => {
        throw new Error("no Jira OAuth app available");
      },
      now: () => 1000,
    });
    expect(isSourceUnauthenticated(await rejection(a.authorize()))).toBe(true);
  });
});
