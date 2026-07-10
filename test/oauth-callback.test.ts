// The resident server's OAuth callback relay: the /oauth/callback (browser lands here) +
// /oauth/callback-result (login initiator polls) routes, and the in-memory store behind them.
import { describe, it, expect, beforeEach } from "vitest";
import { createApp, type ServerContext } from "../src/server/app.ts";
import { getCallback, recordCallback, resetOAuthCallbacks } from "../src/server/oauth-callback.ts";

const stubCtx: ServerContext = {
  health: () => ({ ok: true, version: "test", pid: 0, startedAt: 0, uptimeSec: 0, repos: [], oauthCallback: false }),
  reload: async () => ({ repos: [], failures: [] }),
  requestShutdown: () => {},
  getRepo: () => undefined,
  knownRepos: () => [],
};

describe("oauth-callback store", () => {
  beforeEach(resetOAuthCallbacks);
  it("records + reads a code by state; unknown state is undefined", () => {
    expect(getCallback("s")).toBeUndefined();
    recordCallback("s", { code: "ABC" });
    expect(getCallback("s")).toEqual({ code: "ABC" });
    recordCallback("e", { error: "denied" });
    expect(getCallback("e")).toEqual({ error: "denied" });
  });
});

describe("server OAuth callback routes", () => {
  beforeEach(resetOAuthCallbacks);

  it("callback stashes the code; callback-result goes pending → done", async () => {
    const app = createApp(stubCtx);
    expect(await (await app.request("/oauth/callback-result?state=S1")).json()).toEqual({ status: "pending" });

    const cb = await app.request("/oauth/callback?state=S1&code=ABC");
    expect(cb.status).toBe(200); // a friendly HTML "close this tab" page
    expect(cb.headers.get("content-type")).toMatch(/html/);

    expect(await (await app.request("/oauth/callback-result?state=S1")).json()).toEqual({ status: "done", code: "ABC" });
  });

  it("an authorization error propagates through the relay", async () => {
    const app = createApp(stubCtx);
    await app.request("/oauth/callback?state=S2&error=access_denied");
    expect(await (await app.request("/oauth/callback-result?state=S2")).json()).toEqual({ status: "error", error: "access_denied" });
  });

  it("callback-result requires a state", async () => {
    const app = createApp(stubCtx);
    const r = await app.request("/oauth/callback-result");
    expect(r.status).toBe(400);
  });
});
