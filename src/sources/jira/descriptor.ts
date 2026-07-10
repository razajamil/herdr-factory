import { z } from "zod";
import { JiraSource, type JiraAuthCfg, type JiraSourceCfg } from "../../clients/jira-source.ts";
import { JiraApiTokenAuth, JiraOAuthAuth, type JiraAuth } from "../../auth/jira-provider.ts";
import { DEFAULT_JIRA_SCOPES, resolveJiraOAuthApp } from "../../auth/jira-oauth.ts";
import type { SourceDescriptor } from "../registry.ts";

// How a Jira source authenticates — a discriminated union on `method` (same idiom as source `type`).
// api_token (DEFAULT, back-compatible): email + token from env. oauth: browser login (PKCE public
// client — NO secret), factory-managed tokens, against the shipped public client_id unless
// overridden per-source with client_id (here). Omitting `auth` entirely ⇒ api_token, so existing
// configs are unchanged.
const JiraAuthSchema = z
  .discriminatedUnion("method", [
    z.object({ method: z.literal("api_token") }).strict(),
    z
      .object({
        method: z.literal("oauth"),
        client_id: z.string().trim().min(1).optional(), // override the built-in app (else the shipped one)
        scopes: z.array(z.string().trim().min(1)).min(1).optional(), // else DEFAULT_JIRA_SCOPES
      })
      .strict(),
  ])
  .default({ method: "api_token" });

// The Jira source's where-to-poll block. base_url is the Atlassian site. For api_token, auth (email +
// token) lives in the per-repo env file; for oauth, tokens are managed by the factory (auth login).
// The pickup label is NOT here — it's per-belt now (belt.label, threaded into listEligible/health).
const JiraBlockSchema = z.object({
  base_url: z.url().transform((s) => s.replace(/\/+$/, "")),
  project: z.string(),
  board: z.coerce.string(),
  status: z
    .object({
      todo: z.string().default("To Do"),
      in_development: z.string().default("In Progress"),
      review: z.string().default("In Review"),
    })
    .prefault({}),
  auth: JiraAuthSchema,
});

const sourceName = z.string().trim().min(1).optional();

/** Raw parse output of the jira source object (post-zod, pre-resolve). */
interface JiraParsed {
  type: "jira";
  name?: string;
  jira: z.infer<typeof JiraBlockSchema>;
}

export const jiraDescriptor: SourceDescriptor<JiraSourceCfg> = {
  type: "jira",
  pickupLabel: { noun: "label" },
  configSchema: z.object({ type: z.literal("jira"), name: sourceName, jira: JiraBlockSchema }).strict(),
  resolveConfig(parsed) {
    const s = parsed as unknown as JiraParsed;
    const a = s.jira.auth;
    const auth: JiraAuthCfg =
      a.method === "oauth" ? { method: "oauth", clientId: a.client_id, scopes: a.scopes ?? DEFAULT_JIRA_SCOPES } : { method: "api_token" };
    return {
      baseUrl: s.jira.base_url,
      project: s.jira.project,
      board: s.jira.board,
      statusTodo: s.jira.status.todo,
      statusInDev: s.jira.status.in_development,
      statusReview: s.jira.status.review,
      auth,
    };
  },
  create(ctx) {
    const cfg = ctx.cfg;
    let auth: JiraAuth;
    if (cfg.auth.method === "oauth") {
      const { clientId } = cfg.auth;
      // App resolution is LAZY (only a refresh/login needs it) so an oauth source that isn't logged
      // in yet still starts — it just reports unauthenticated until `auth login`. Public client
      // (PKCE): only the public client_id is needed — no secret.
      auth = new JiraOAuthAuth({
        store: ctx.store,
        repo: ctx.repoName,
        source: ctx.sourceName,
        resolveApp: () => resolveJiraOAuthApp({ clientId }),
      });
    } else {
      auth = new JiraApiTokenAuth(cfg.baseUrl, ctx.env.JIRA_EMAIL ?? "", ctx.env.JIRA_API_TOKEN ?? "");
    }
    return new JiraSource(cfg, auth);
  },
  // Presence is NOT hard-required here anymore — which credentials a source needs depends on its
  // auth.method (api_token vs oauth), which this static manifest can't see. The per-source `auth`
  // doctor line (authStatus / INV-12) gives the accurate, method-aware verdict; these entries just
  // drive the TUI credential rows + doctor's hints. OAuth (auth.method: oauth) has NO env secret —
  // it's a public PKCE client (browser login via `auth login`), so nothing to list here for it.
  secrets: [
    { envKey: "JIRA_EMAIL", required: false, placeholder: "you@org.com", hint: "the Atlassian account email (auth.method: api_token)" },
    { envKey: "JIRA_API_TOKEN", required: false, masked: true, hint: "an Atlassian API token (auth.method: api_token; id.atlassian.com → Security → API tokens)" },
  ],
  tui: {
    defaultBlock: () => ({
      base_url: "",
      project: "",
      board: "",
      status: { todo: "To Do", in_development: "In Progress", review: "In Review" },
    }),
    fields: [
      { label: "jira.base_url", path: ["jira", "base_url"], placeholder: "https://org.atlassian.net" },
      { label: "jira.project", path: ["jira", "project"], placeholder: "PROJ" },
      { label: "jira.board", path: ["jira", "board"], placeholder: "123" },
      { label: "status.todo", path: ["jira", "status", "todo"], placeholder: "To Do" },
      { label: "status.in_development", path: ["jira", "status", "in_development"], placeholder: "In Progress" },
      { label: "status.review", path: ["jira", "status", "review"], placeholder: "In Review" },
      // api_token = JIRA_EMAIL + JIRA_API_TOKEN from env; oauth = browser login (`auth login`), no
      // secret. Choosing oauth writes `auth: { method: oauth }`, which uses the built-in public app;
      // a per-source client_id override is a rare case left to the YAML (no field for it here).
      { label: "auth.method", path: ["jira", "auth", "method"], choices: ["api_token", "oauth"], enumDefault: "api_token" },
    ],
  },
};
