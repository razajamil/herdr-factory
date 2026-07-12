// The Atlassian 3LO protocol helpers (src/auth/jira-oauth.ts) — the PKCE public-client specifics:
// a proper S256 challenge, a secretless authorize URL + code exchange, cloud-resource matching, and
// the client_id-only app resolver.
import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { buildAuthorizeUrl, exchangeCode, newPkcePair, pickResource, resolveJiraOAuthApp } from "../src/auth/jira-oauth.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("jira-oauth PKCE + public client", () => {
  it("newPkcePair produces a spec-length verifier and its S256/base64url challenge", () => {
    const { verifier, challenge } = newPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(newPkcePair().verifier).not.toBe(verifier); // fresh each call
  });

  it("buildAuthorizeUrl carries the S256 challenge + client_id; the secret is never in the authorize URL", () => {
    const url = new URL(buildAuthorizeUrl({ app: { clientId: "cid", brokerUrl: "http://127.0.0.1:9099" }, redirectUri: "http://127.0.0.1:9/callback", scopes: ["read:jira-work", "offline_access"], state: "st", codeChallenge: "chal" }));
    expect(url.origin + url.pathname).toBe("https://auth.atlassian.com/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("read:jira-work offline_access");
    expect(url.searchParams.has("client_secret")).toBe(false);
  });

  it("exchangeCode posts to the BROKER with the code + code_verifier and NO client credentials", async () => {
    let url = "";
    let body: Record<string, string> = {};
    globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
      url = String(u);
      body = JSON.parse(String(init?.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: "AT", refresh_token: "RT", expires_in: 3600, scope: "s" }), headers: new Headers() } as Response;
    }) as typeof fetch;
    const tokens = await exchangeCode({ app: { clientId: "cid", brokerUrl: "http://127.0.0.1:9099" }, code: "CODE", redirectUri: "http://127.0.0.1:8976/oauth/callback", codeVerifier: "VER" });
    expect(url).toBe("http://127.0.0.1:9099/oauth/token"); // the broker, not Atlassian directly
    expect(body).toMatchObject({ grant_type: "authorization_code", code: "CODE", code_verifier: "VER", redirect_uri: "http://127.0.0.1:8976/oauth/callback" });
    expect(body.client_secret).toBeUndefined();
    expect(body.client_id).toBeUndefined(); // the broker injects both client credentials
    expect(tokens.accessToken).toBe("AT");
  });

  it("resolveJiraOAuthApp returns client_id + broker URL (no secret); broker URL overridable, else local default", () => {
    expect(resolveJiraOAuthApp({ clientId: "id", brokerUrl: "https://broker.example/" })).toEqual({ clientId: "id", brokerUrl: "https://broker.example" }); // trailing slash trimmed
    const dflt = resolveJiraOAuthApp({ clientId: "id" });
    expect(dflt.brokerUrl).toBe("http://127.0.0.1:9099"); // DEFAULT_BROKER_URL
  });

  it("pickResource matches the configured site URL, else falls back to a lone resource, else throws", () => {
    const rs = [
      { id: "c1", url: "https://acme.atlassian.net", name: "Acme", scopes: [] },
      { id: "c2", url: "https://other.atlassian.net", name: "Other", scopes: [] },
    ];
    expect(pickResource(rs, "https://acme.atlassian.net/").id).toBe("c1"); // trailing slash tolerated
    expect(pickResource([rs[0]!], "https://mismatch.atlassian.net").id).toBe("c1"); // lone resource
    expect(() => pickResource(rs, "https://mismatch.atlassian.net")).toThrow(/none matches/);
  });
});
