// Zod request/response schemas + OpenAPI route definitions for the server. These drive BOTH the
// runtime request validation (params/query/body, via @hono/zod-openapi) AND the generated OpenAPI
// document served at /doc (rendered by Swagger UI at /ui). Handlers live in app.ts.
import { createRoute, z } from "@hono/zod-openapi";

// ---- shared ---------------------------------------------------------------
export const RepoParam = z.object({
  repo: z.string().openapi({ param: { name: "repo", in: "path" }, example: "reckon-frontend" }),
});

const ErrorResponse = z.object({ error: z.string() }).openapi("Error");
const OkResponse = z.object({ ok: z.boolean() }).openapi("Ok");

/** Shared error response entry (400/404/500 all return `{ error }`). */
const errResp = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorResponse } },
});
/** The three error responses every repo-scoped route can produce. */
const repoErrors = {
  400: errResp("Invalid request"),
  404: errResp("Repo not configured"),
  500: errResp("Server error"),
};

// ---- response bodies ------------------------------------------------------
const HealthResponse = z
  .object({
    ok: z.boolean(),
    version: z.string(),
    pid: z.number(),
    startedAt: z.number(),
    uptimeSec: z.number(),
    repos: z.array(
      z.object({
        name: z.string(),
        active: z.number(),
        lastTickAt: z.number().nullable(),
        tickStale: z.boolean(),
      }),
    ),
  })
  .openapi("Health");

const ReloadResponse = z
  .object({
    ok: z.boolean(), // false ⇒ at least one configured repo failed to load (see failures)
    repos: z.array(z.string()),
    failures: z.array(z.object({ name: z.string(), error: z.string() })),
  })
  .openapi("Reload");
const TickResponse = z.object({ ran: z.boolean() }).openapi("Tick");
const StepDoneResponse = z
  .object({ ok: z.boolean(), advanced: z.boolean().optional(), message: z.string().optional() })
  .openapi("StepDone");
const AskHumanResponse = z
  .object({ ok: z.boolean(), questionId: z.number().optional(), posted: z.boolean().optional(), message: z.string().optional() })
  .openapi("AskHuman");
const BounceResponse = z.object({ ok: z.boolean(), escalated: z.boolean().optional(), message: z.string().optional() }).openapi("Bounce");
const CaptureAttemptResponse = z
  .object({ ok: z.boolean(), attempts: z.number().optional(), escalated: z.boolean().optional(), message: z.string().optional() })
  .openapi("CaptureAttempt");
const ResumeResponse = z.object({ ok: z.boolean(), phase: z.string().optional(), message: z.string().optional() }).openapi("Resume");

const RunSchema = z
  .object({
    id: z.number(),
    repo: z.string(),
    workSource: z.string().nullable(),
    belt: z.string().nullable(),
    ticketKey: z.string(),
    summary: z.string().nullable(),
    issueType: z.string().nullable(),
    branch: z.string().nullable(),
    phase: z.string(),
    step: z.string().nullable(),
    prNumber: z.number().nullable(),
    outcome: z.string().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
    endedAt: z.number().nullable(),
  })
  .openapi("Run");
const RunsResponse = z.object({ runs: z.array(RunSchema) }).openapi("Runs");

const StatusResponse = z
  .object({
    repo: z.string(),
    limits: z.object({ maxActiveWorkspaces: z.number() }),
    // `auth` is the per-source authentication light (same vocab as evidenceSso). "down" = the source
    // can't authenticate (its claims + write-backs are paused, auto-resuming on re-auth); "na" = no auth.
    sources: z.array(z.object({ name: z.string(), type: z.string(), auth: z.object({ state: z.enum(["ok", "down", "na"]), detail: z.string().optional() }) })),
    belts: z.array(z.object({ name: z.string(), beltType: z.string(), source: z.string(), priority: z.number() })),
    active: z.array(
      z.object({
        id: z.number(),
        ticketKey: z.string(),
        workSource: z.string().nullable(),
        belt: z.string().nullable(),
        phase: z.string(),
        step: z.string().nullable(),
        prNumber: z.number().nullable(),
        summary: z.string().nullable(),
        outcome: z.string().nullable(),
        worker: z.string().nullable(),
        steps: z.array(z.object({ step: z.string(), done: z.boolean() })),
      }),
    ),
    finished: z.array(
      z.object({
        id: z.number(),
        ticketKey: z.string(),
        phase: z.string(),
        outcome: z.string().nullable(),
        prNumber: z.number().nullable(),
      }),
    ),
    // Evidence-upload credential (AWS SSO) health, for the dashboard SSO light. "na" = no evidence config.
    evidenceSso: z.object({ state: z.enum(["ok", "down", "na"]), detail: z.string().optional() }),
  })
  .openapi("Status");

const EligibleResponse = z
  .object({
    eligible: z.array(
      z.object({ source: z.string(), key: z.string(), summary: z.string(), type: z.string() }),
    ),
  })
  .openapi("Eligible");

const TimelineResponse = z
  .object({
    timeline: z.array(z.object({ ts: z.number(), type: z.string(), detail: z.string().nullable() })),
  })
  .openapi("Timeline");

// ---- request bodies -------------------------------------------------------
// `step` is any string — it's validated against the run's resolved belt in the handler, since the
// valid step set is belt-specific (and the belt isn't known until the run is resolved from `key`).
export const StepDoneBody = z
  .object({ key: z.string(), step: z.string(), source: z.string().optional() })
  .openapi("StepDoneBody");
export const AskHumanBody = z
  .object({ key: z.string(), step: z.string(), source: z.string().optional(), question: z.string().min(1) })
  .openapi("AskHumanBody");
// `toStep` is validated against the run's resolved belt in the handler (must be an earlier step the
// current step is allowed to bounce to) — like `step` on step-done, the valid set is belt-specific.
export const BounceBody = z
  .object({ key: z.string(), toStep: z.string(), source: z.string().optional(), reason: z.string().min(1) })
  .openapi("BounceBody");
// No step field: the attempt always applies to the run's current running step (the engine validates
// it is a gathersEvidence step), so the agent can't misattribute it.
export const CaptureAttemptBody = z.object({ key: z.string(), step: z.string(), source: z.string().optional() }).openapi("CaptureAttemptBody");
export const ClaimBody = z.object({ key: z.string(), belt: z.string().optional() }).openapi("ClaimBody");
export const TeardownBody = z.object({ key: z.string(), source: z.string().optional() }).openapi("TeardownBody");
export const ResumeBody = z.object({ key: z.string(), source: z.string().optional() }).openapi("ResumeBody");

const jsonBody = <T extends z.ZodType>(schema: T) => ({
  body: { required: true, content: { "application/json": { schema } } },
});

// ---- routes ---------------------------------------------------------------
export const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["server"],
  summary: "Liveness probe + running version",
  responses: { 200: { description: "Healthy", content: { "application/json": { schema: HealthResponse } } } },
});

export const reloadRoute = createRoute({
  method: "post",
  path: "/reload",
  tags: ["server"],
  summary: "Re-read every repo's config + re-discover repos (no restart)",
  responses: { 200: { description: "Reloaded", content: { "application/json": { schema: ReloadResponse } } } },
});

export const shutdownRoute = createRoute({
  method: "post",
  path: "/shutdown",
  tags: ["server"],
  summary: "Graceful drain + exit",
  responses: { 200: { description: "Shutting down", content: { "application/json": { schema: OkResponse } } } },
});

export const tickRoute = createRoute({
  method: "post",
  path: "/repos/{repo}/tick",
  tags: ["repo"],
  summary: "Run one reconcile pass for the repo",
  request: { params: RepoParam },
  responses: {
    200: { description: "Tick result", content: { "application/json": { schema: TickResponse } } },
    ...repoErrors,
  },
});

export const stepDoneRoute = createRoute({
  method: "post",
  path: "/repos/{repo}/step-done",
  tags: ["repo"],
  summary: "A belt agent signals it finished a step — event-nudges the dispatcher",
  request: { params: RepoParam, ...jsonBody(StepDoneBody) },
  responses: {
    200: { description: "Step recorded", content: { "application/json": { schema: StepDoneResponse } } },
    ...repoErrors,
  },
});

export const askHumanRoute = createRoute({
  method: "post",
  path: "/repos/{repo}/ask-human",
  tags: ["repo"],
  summary: "A belt agent asks a human through its work source and pauses the run",
  request: { params: RepoParam, ...jsonBody(AskHumanBody) },
  responses: {
    200: { description: "Question recorded", content: { "application/json": { schema: AskHumanResponse } } },
    ...repoErrors,
  },
});

export const bounceRoute = createRoute({
  method: "post",
  path: "/repos/{repo}/bounce",
  tags: ["repo"],
  summary: "A belt agent sends the run back to an earlier step for rework",
  request: { params: RepoParam, ...jsonBody(BounceBody) },
  responses: {
    200: { description: "Bounce recorded", content: { "application/json": { schema: BounceResponse } } },
    ...repoErrors,
  },
});

export const captureAttemptRoute = createRoute({
  method: "post",
  path: "/repos/{repo}/capture-attempt",
  tags: ["repo"],
  summary: "An evidence agent signals a capture attempt — the engine caps flaky-capture loops",
  request: { params: RepoParam, ...jsonBody(CaptureAttemptBody) },
  responses: {
    200: { description: "Attempt recorded", content: { "application/json": { schema: CaptureAttemptResponse } } },
    ...repoErrors,
  },
});

export const claimRoute = createRoute({
  method: "post",
  path: "/repos/{repo}/claim",
  tags: ["repo"],
  summary: "Manually claim + start one work item",
  request: { params: RepoParam, ...jsonBody(ClaimBody) },
  responses: {
    200: { description: "Claimed", content: { "application/json": { schema: OkResponse } } },
    ...repoErrors,
  },
});

export const resumeRoute = createRoute({
  method: "post",
  path: "/repos/{repo}/resume",
  tags: ["repo"],
  summary: "Un-park a run from `attention` back to where it was (running/reviewing/claiming)",
  request: { params: RepoParam, ...jsonBody(ResumeBody) },
  responses: {
    200: { description: "Resume result", content: { "application/json": { schema: ResumeResponse } } },
    ...repoErrors,
  },
});

export const teardownRoute = createRoute({
  method: "post",
  path: "/repos/{repo}/teardown",
  tags: ["repo"],
  summary: "Tear down one work item's worktree",
  request: { params: RepoParam, ...jsonBody(TeardownBody) },
  responses: {
    200: { description: "Torn down", content: { "application/json": { schema: OkResponse } } },
    ...repoErrors,
  },
});

export const statusRoute = createRoute({
  method: "get",
  path: "/repos/{repo}/status",
  tags: ["repo"],
  summary: "Dashboard status: active + finished runs, sources, limits",
  request: { params: RepoParam },
  responses: {
    200: { description: "Status", content: { "application/json": { schema: StatusResponse } } },
    ...repoErrors,
  },
});

export const runsRoute = createRoute({
  method: "get",
  path: "/repos/{repo}/runs",
  tags: ["repo"],
  summary: "List runs (active only, or all with ?all)",
  request: { params: RepoParam, query: z.object({ all: z.string().optional() }) },
  responses: {
    200: { description: "Runs", content: { "application/json": { schema: RunsResponse } } },
    ...repoErrors,
  },
});

export const eligibleRoute = createRoute({
  method: "get",
  path: "/repos/{repo}/eligible",
  tags: ["repo"],
  summary: "List eligible (todo) work items across all sources",
  request: { params: RepoParam },
  responses: {
    200: { description: "Eligible items", content: { "application/json": { schema: EligibleResponse } } },
    ...repoErrors,
  },
});

export const timelineRoute = createRoute({
  method: "get",
  path: "/repos/{repo}/timeline",
  tags: ["repo"],
  summary: "Event timeline for a ticket (?key=)",
  request: { params: RepoParam, query: z.object({ key: z.string() }) },
  responses: {
    200: { description: "Timeline", content: { "application/json": { schema: TimelineResponse } } },
    ...repoErrors,
  },
});
