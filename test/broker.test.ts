// The OAuth token broker (src/broker): injects the client_id + client_secret it holds and forwards
// the token request to Atlassian, returning the response verbatim. The client never sends a secret.
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createBrokerApp } from "../src/broker/broker.ts";

const realFetch = globalThis.fetch;
const saved = { id: process.env.JIRA_OAUTH_CLIENT_ID, secret: process.env.JIRA_OAUTH_CLIENT_SECRET };

beforeEach(() => {
  delete process.env.JIRA_OAUTH_CLIENT_ID;
  delete process.env.JIRA_OAUTH_CLIENT_SECRET;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.JIRA_OAUTH_CLIENT_ID = saved.id;
  process.env.JIRA_OAUTH_CLIENT_SECRET = saved.secret;
});

const post = (grant: Record<string, unknown>) =>
  createBrokerApp().request("/oauth/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(grant) });

describe("OAuth broker /oauth/token", () => {
  it("injects client_id + client_secret and forwards the grant to Atlassian verbatim", async () => {
    process.env.JIRA_OAUTH_CLIENT_ID = "the-id";
    process.env.JIRA_OAUTH_CLIENT_SECRET = "the-secret";
    let forwardedUrl = "";
    let forwarded: Record<string, string> = {};
    globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
      forwardedUrl = String(u);
      forwarded = JSON.parse(String(init?.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: "AT" }), headers: new Headers({ "content-type": "application/json" }) } as Response;
    }) as typeof fetch;

    const res = await post({ grant_type: "authorization_code", code: "C", code_verifier: "V", redirect_uri: "R", extra: "dropped" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ access_token: "AT" });
    expect(forwardedUrl).toBe("https://auth.atlassian.com/oauth/token");
    // Injected the credentials; forwarded only the whitelisted grant fields (no `extra`).
    expect(forwarded).toEqual({ client_id: "the-id", client_secret: "the-secret", grant_type: "authorization_code", code: "C", code_verifier: "V", redirect_uri: "R" });
  });

  it("forwards Atlassian's error status + body verbatim (e.g. a 401)", async () => {
    process.env.JIRA_OAUTH_CLIENT_SECRET = "s";
    globalThis.fetch = (async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: "access_denied" }), headers: new Headers({ "content-type": "application/json" }) }) as Response) as typeof fetch;
    const res = await post({ grant_type: "refresh_token", refresh_token: "RT" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "access_denied" });
  });

  it("rejects an unsupported grant_type (400) — never reaches Atlassian", async () => {
    process.env.JIRA_OAUTH_CLIENT_SECRET = "s";
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return {} as Response;
    }) as typeof fetch;
    const res = await post({ grant_type: "password", username: "x" });
    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });

  it("500s (with an actionable message) when no client secret is configured", async () => {
    const res = await post({ grant_type: "refresh_token", refresh_token: "RT" });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error_description?: string }).error_description).toMatch(/JIRA_OAUTH_CLIENT_SECRET/);
  });
});
