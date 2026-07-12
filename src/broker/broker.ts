// The OAuth token broker — a small standalone server that holds the Jira OAuth client_secret so it
// never ships to a herdr-factory client. The factory (CLI `auth login` + the resident server's token
// refresh) POSTs grant params here (code + PKCE verifier, or a refresh_token); the broker injects
// client_id + client_secret and forwards to Atlassian's token endpoint, returning the response
// verbatim. It is a THIN, STATELESS proxy: it never stores tokens and never touches Jira data — it
// only adds client authentication to the token exchange.
//
// Run it with `herdr-factory oauth-broker`. Credentials come from its OWN env: JIRA_OAUTH_CLIENT_SECRET
// (required) + JIRA_OAUTH_CLIENT_ID (optional, defaults to the baked public id). Local-only for now
// (binds 127.0.0.1); hosting it elsewhere later means locking down access (auth, rate limits) — the
// broker deliberately does NO caller authentication yet, which is safe only on loopback.
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { ATLASSIAN_TOKEN_URL, BUILT_IN_CLIENT_ID, DEFAULT_BROKER_PORT } from "../auth/jira-oauth.ts";
import { recordOAuthEvent, telemetrySpan } from "../telemetry/index.ts";

/** Count a broker outcome on the `oauth_events` counter (phase=broker_forward). Errors carry an
 *  `oauth.error` reason so bad-grant / no-secret / upstream failures are distinguishable in metrics. */
function brokerEvent(outcome: "ok" | "error", attrs: Record<string, string | number> = {}): void {
  recordOAuthEvent({ "oauth.phase": "broker_forward", "oauth.outcome": outcome, ...attrs });
}

/** The client credentials the broker injects. Secret is required; id defaults to the baked public id. */
function brokerCreds(): { clientId: string; clientSecret: string } {
  const clientId = process.env.JIRA_OAUTH_CLIENT_ID?.trim() || BUILT_IN_CLIENT_ID;
  const clientSecret = process.env.JIRA_OAUTH_CLIENT_SECRET?.trim();
  if (!clientSecret) throw new Error("the OAuth broker needs JIRA_OAUTH_CLIENT_SECRET in its environment (from developer.atlassian.com → your app → Settings)");
  return { clientId, clientSecret };
}

/** Only these grant fields are forwarded — the client can't smuggle arbitrary params to Atlassian. */
const FORWARDED_FIELDS = ["grant_type", "code", "code_verifier", "redirect_uri", "refresh_token"] as const;

export function createBrokerApp(): Hono {
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true }));
  app.post("/oauth/token", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      brokerEvent("error", { "oauth.error": "invalid_request" });
      return c.json({ error: "invalid_request", error_description: "expected a JSON body" }, 400);
    }
    const grantType = String(body.grant_type ?? "");
    if (grantType !== "authorization_code" && grantType !== "refresh_token") {
      brokerEvent("error", { "oauth.error": "unsupported_grant_type", "oauth.grant_type": grantType });
      return c.json({ error: "unsupported_grant_type", error_description: "only authorization_code and refresh_token are brokered" }, 400);
    }
    let creds: { clientId: string; clientSecret: string };
    try {
      creds = brokerCreds();
    } catch (e) {
      brokerEvent("error", { "oauth.error": "no_client_secret", "oauth.grant_type": grantType });
      return c.json({ error: "server_error", error_description: e instanceof Error ? e.message : String(e) }, 500);
    }
    const forward: Record<string, string> = { client_id: creds.clientId, client_secret: creds.clientSecret };
    for (const k of FORWARDED_FIELDS) if (typeof body[k] === "string") forward[k] = body[k] as string;

    // Span the upstream forward (raw fetch — not httpOk, so not otherwise instrumented) + record the
    // outcome. The span nests any parent trace context propagated from the caller.
    return telemetrySpan("oauth.broker.token", { "oauth.phase": "broker_forward", "oauth.grant_type": grantType }, async (span) => {
      const upstream = await fetch(ATLASSIAN_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(forward),
        signal: AbortSignal.timeout(30_000),
      }).catch((e) => (e instanceof Error ? e : new Error(String(e))));
      if (upstream instanceof Error) {
        span.recordException(upstream);
        brokerEvent("error", { "oauth.error": "upstream_unreachable", "oauth.grant_type": grantType });
        return c.json({ error: "temporarily_unavailable", error_description: `broker could not reach Atlassian: ${upstream.message}` }, 502);
      }
      span.setAttribute("oauth.upstream_status", upstream.status);
      brokerEvent(upstream.ok ? "ok" : "error", { "oauth.grant_type": grantType, "oauth.upstream_status": upstream.status });
      // Forward Atlassian's response verbatim (status + body) so token errors surface unchanged.
      const text = await upstream.text();
      return new Response(text, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" } });
    });
  });
  return app;
}

/** Run the broker (resident; kept alive by its listener). Validates creds up front so a missing
 *  secret fails loudly at startup rather than on the first request. */
export async function serveBroker(): Promise<void> {
  const port = Number(process.env.HERDR_FACTORY_BROKER_PORT) || DEFAULT_BROKER_PORT;
  const { clientId } = brokerCreds(); // throws now if JIRA_OAUTH_CLIENT_SECRET is unset
  await new Promise<void>((resolve, reject) => {
    const srv = serve({ fetch: createBrokerApp().fetch, port, hostname: "127.0.0.1" }, () => {
      process.stdout.write(`herdr-factory OAuth broker on http://127.0.0.1:${port} — client_id ${clientId.slice(0, 6)}…, secret held here (never shipped)\n`);
      resolve();
    });
    srv.once("error", reject);
  });
}
