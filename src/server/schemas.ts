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
    repos: z.array(z.object({ name: z.string(), active: z.number() })),
  })
  .openapi("Health");

const ReloadResponse = z.object({ ok: z.boolean(), repos: z.array(z.string()) }).openapi("Reload");
const TickResponse = z.object({ ran: z.boolean() }).openapi("Tick");
const StepDoneResponse = z
  .object({ ok: z.boolean(), advanced: z.boolean().optional(), message: z.string().optional() })
  .openapi("StepDone");

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
    limits: z.object({ maxActive: z.number(), watchHours: z.number() }),
    sources: z.array(z.object({ name: z.string(), type: z.string() })),
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
export const ClaimBody = z.object({ key: z.string(), belt: z.string().optional() }).openapi("ClaimBody");
export const TeardownBody = z.object({ key: z.string(), source: z.string().optional() }).openapi("TeardownBody");

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
