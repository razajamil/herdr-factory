// jiraOAuthLogin (src/auth/jira-login.ts): the full browser-login assembly — exchange the code via
// the broker, discover the cloud resource, persist tokens, then a best-effort whoami that records
// WHICH account we authenticated as. The whoami must never fail an otherwise-successful login.
import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "../src/db/index.ts";
import { Store } from "../src/db/store.ts";
import { jiraOAuthLogin } from "../src/auth/jira-login.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const j = (body: unknown, status = 200) =>
  ({ ok: status < 300, status, text: async () => JSON.stringify(body), headers: new Headers() }) as Response;

const login = (store: Store) =>
  jiraOAuthLogin({
    store,
    repo: "r",
    source: "jira",
    siteBaseUrl: "https://x.atlassian.net",
    app: { clientId: "cid", brokerUrl: "http://127.0.0.1:9099" },
    scopes: ["read:jira-work", "read:jira-user", "offline_access"],
    now: () => 1000,
    getCode: async () => "CODE",
  });

describe("jiraOAuthLogin", () => {
  it("exchanges the code, saves tokens, and persists the whoami account", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url); // NB: accessible-resources lives under /oauth/token/… — match it FIRST
      if (u.includes("accessible-resources")) return j([{ id: "CID", url: "https://x.atlassian.net", name: "Acme", scopes: [] }]);
      if (u.includes("/rest/api/3/myself")) return j({ accountId: "acc-1", displayName: "Raza Jamil", emailAddress: "raza@x.com" });
      if (u.includes("/oauth/token")) return j({ access_token: "AT", refresh_token: "RT", expires_in: 3600, scope: "read:jira-work read:jira-user offline_access" });
      throw new Error("unexpected fetch: " + u);
    }) as typeof fetch;

    const store = new Store(openDb(":memory:"), () => 1000);
    const result = await login(store);

    expect(result.account).toEqual({ accountId: "acc-1", displayName: "Raza Jamil", email: "raza@x.com" });
    const saved = store.getSourceAuth("r", "jira")!;
    expect([saved.accessToken, saved.cloudId, saved.accountLabel]).toEqual(["AT", "CID", "Raza Jamil <raza@x.com>"]);
  });

  it("still logs in (account undefined, label null) when the whoami 401s — best-effort", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url); // NB: accessible-resources lives under /oauth/token/… — match it FIRST
      if (u.includes("accessible-resources")) return j([{ id: "CID", url: "https://x.atlassian.net", name: "Acme", scopes: [] }]);
      if (u.includes("/rest/api/3/myself")) return j({ error: "scope does not match" }, 401); // no read:jira-user
      if (u.includes("/oauth/token")) return j({ access_token: "AT", refresh_token: "RT", expires_in: 3600, scope: "read:jira-work" });
      throw new Error("unexpected fetch: " + u);
    }) as typeof fetch;

    const store = new Store(openDb(":memory:"), () => 1000);
    const result = await login(store);

    expect(result.account).toBeUndefined();
    const saved = store.getSourceAuth("r", "jira")!;
    expect(saved.accessToken).toBe("AT"); // login succeeded despite the whoami rejection
    expect(saved.accountLabel).toBeNull();
  });
});
