// The Hono OpenAPI app: route definitions (schemas.ts) wired to handlers, plus the OpenAPI JSON
// document (/doc) and Swagger UI (/ui). All resident state + lifecycle lives in serve.ts and is
// injected here via `ServerContext`; this module is pure request → response wiring. Request bodies,
// params and query strings are validated by the route schemas before a handler runs; validation
// failures and thrown errors are normalised to `{ error }` (the shape server/client.ts expects).
import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { VERSION } from "../version.ts";
import { claimTicket, reconcileRepo, reconcileRun, teardownTicket, withTickLock } from "../core/reconcile.ts";
import { stepByName } from "../core/step.ts";
import { resolveActiveRun, resolveBeltName } from "../resolve.ts";
import type { Deps } from "../core/deps.ts";
import {
  claimRoute,
  eligibleRoute,
  healthRoute,
  reloadRoute,
  runsRoute,
  shutdownRoute,
  statusRoute,
  stepDoneRoute,
  teardownRoute,
  tickRoute,
  timelineRoute,
} from "./schemas.ts";

/** A repo the resident server is currently serving: its injected Deps + tick-loop bookkeeping. */
export interface RepoRuntime {
  deps: Deps;
  timer?: NodeJS.Timeout;
  ticking: boolean;
}

/** The /health payload (also what `ensure-up`/pingHealth read back). */
export interface HealthInfo {
  ok: boolean;
  version: string;
  pid: number;
  startedAt: number;
  uptimeSec: number;
  repos: { name: string; active: number }[];
}

/** Everything the HTTP layer needs from the resident lifecycle (implemented in serve.ts). */
export interface ServerContext {
  health(): HealthInfo;
  reload(): Promise<string[]>;
  requestShutdown(why: string): void;
  getRepo(name: string): RepoRuntime | undefined;
  knownRepos(): string[];
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The structured status payload — same data the CLI `status` renders, exposed for the web UI.
 *  Hits herdr for live pane state, so it's async. */
async function statusPayload(rt: RepoRuntime) {
  const cfg = rt.deps.config;
  const active = rt.deps.store.activeRuns(cfg.repoName);
  const finished = rt.deps.store.listRuns(cfg.repoName, true).filter((r) => r.endedAt !== null);
  const runView = async (r: (typeof active)[number]) => ({
    id: r.id,
    ticketKey: r.ticketKey,
    workSource: r.workSource,
    belt: r.belt,
    phase: r.phase as string,
    step: r.step,
    prNumber: r.prNumber,
    summary: r.summary,
    outcome: r.outcome as string | null,
    worker: r.paneId ? await rt.deps.herdr.paneState(r.paneId) : null,
    steps: rt.deps.store.runStepsFor(r.id).map((s) => ({ step: s.step as string, done: s.done })),
  });
  return {
    repo: cfg.repoName,
    limits: { maxActive: cfg.limits.maxActive, watchHours: cfg.limits.watchHours },
    sources: cfg.sources.map((s) => ({ name: s.name, type: s.type as string })),
    belts: cfg.belts.map((b) => ({ name: b.name, beltType: b.beltType as string, source: b.source, priority: b.priority })),
    active: await Promise.all(active.map(runView)),
    finished: finished.map((r) => ({
      id: r.id,
      ticketKey: r.ticketKey,
      phase: r.phase as string,
      outcome: r.outcome as string | null,
      prNumber: r.prNumber,
    })),
  };
}

async function eligiblePayload(rt: RepoRuntime): Promise<{ source: string; key: string; summary: string; type: string }[]> {
  const out: { source: string; key: string; summary: string; type: string }[] = [];
  for (const src of rt.deps.sources) {
    try {
      for (const t of await src.client.listEligible()) {
        out.push({ source: src.name, key: t.key, summary: t.summary, type: t.type });
      }
    } catch (e) {
      rt.deps.log("warn", `${src.name}: eligible query failed: ${msg(e)}`);
    }
  }
  return out;
}

/** Build the OpenAPIHono app, wiring each route to a handler that uses the injected `ctx`. */
export function createApp(ctx: ServerContext): OpenAPIHono {
  // defaultHook normalises validation failures to `{ error }` (server/client.ts parses json.error).
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        const detail = result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
        return c.json({ error: detail || "invalid request" }, 400);
      }
    },
  });

  const notConfigured = (repo: string): string =>
    `repo "${repo}" not configured (server knows: ${ctx.knownRepos().join(", ") || "none"})`;

  // --- server-wide ---------------------------------------------------------
  app.openapi(healthRoute, (c) => c.json(ctx.health(), 200));
  app.openapi(reloadRoute, async (c) => c.json({ ok: true, repos: await ctx.reload() }, 200));
  app.openapi(shutdownRoute, (c) => {
    // Fire-and-forget: shutdown drains in-flight ticks (up to 15s) before process.exit, leaving
    // ample time for this response to flush first.
    ctx.requestShutdown("http /shutdown");
    return c.json({ ok: true }, 200);
  });

  // --- repo-scoped ---------------------------------------------------------
  app.openapi(tickRoute, async (c) => {
    const { repo } = c.req.valid("param");
    const rt = ctx.getRepo(repo);
    if (!rt) return c.json({ error: notConfigured(repo) }, 404);
    const ran = await withTickLock(rt.deps, () => reconcileRepo(rt.deps));
    return c.json({ ran }, 200);
  });

  app.openapi(stepDoneRoute, async (c) => {
    const { repo } = c.req.valid("param");
    const { key, step, source } = c.req.valid("json");
    const rt = ctx.getRepo(repo);
    if (!rt) return c.json({ error: notConfigured(repo) }, 404);
    const run = resolveActiveRun(rt.deps, key, source);
    if (!run) return c.json({ ok: false, message: `${key}: no active run` }, 200);
    const belt = rt.deps.resolveBelt(run.belt);
    if (belt && !stepByName(belt, step)) {
      return c.json({ ok: false, message: `${key}: step "${step}" is not in belt "${belt.name}"` }, 200);
    }
    rt.deps.store.markStepDone(run.id, step);
    rt.deps.store.recordEvent({ runId: run.id, repo, ticketKey: key, type: "step_done", detail: { step } });
    rt.deps.log("info", `${key}: step-done ${step} recorded`);
    const advanced = await withTickLock(rt.deps, () => reconcileRun(rt.deps, rt.deps.store.getRun(run.id)!));
    return c.json({ ok: true, advanced }, 200);
  });

  app.openapi(claimRoute, async (c) => {
    const { repo } = c.req.valid("param");
    const { key, belt } = c.req.valid("json");
    const rt = ctx.getRepo(repo);
    if (!rt) return c.json({ error: notConfigured(repo) }, 404);
    await claimTicket(rt.deps, resolveBeltName(rt.deps, belt), key);
    return c.json({ ok: true }, 200);
  });

  app.openapi(teardownRoute, async (c) => {
    const { repo } = c.req.valid("param");
    const { key, source } = c.req.valid("json");
    const rt = ctx.getRepo(repo);
    if (!rt) return c.json({ error: notConfigured(repo) }, 404);
    await teardownTicket(rt.deps, key, source);
    return c.json({ ok: true }, 200);
  });

  app.openapi(statusRoute, async (c) => {
    const { repo } = c.req.valid("param");
    const rt = ctx.getRepo(repo);
    if (!rt) return c.json({ error: notConfigured(repo) }, 404);
    return c.json(await statusPayload(rt), 200);
  });

  app.openapi(runsRoute, async (c) => {
    const { repo } = c.req.valid("param");
    const { all } = c.req.valid("query");
    const rt = ctx.getRepo(repo);
    if (!rt) return c.json({ error: notConfigured(repo) }, 404);
    return c.json({ runs: rt.deps.store.listRuns(repo, all !== undefined) }, 200);
  });

  app.openapi(eligibleRoute, async (c) => {
    const { repo } = c.req.valid("param");
    const rt = ctx.getRepo(repo);
    if (!rt) return c.json({ error: notConfigured(repo) }, 404);
    return c.json({ eligible: await eligiblePayload(rt) }, 200);
  });

  app.openapi(timelineRoute, async (c) => {
    const { repo } = c.req.valid("param");
    const { key } = c.req.valid("query");
    const rt = ctx.getRepo(repo);
    if (!rt) return c.json({ error: notConfigured(repo) }, 404);
    return c.json({ timeline: rt.deps.store.timeline(repo, key) }, 200);
  });

  // --- OpenAPI document + Swagger UI --------------------------------------
  app.doc("/doc", { openapi: "3.0.0", info: { title: "herdr-factory", version: VERSION } });
  app.get("/ui", swaggerUI({ url: "/doc" }));

  app.notFound((c) => c.json({ error: `no route for ${c.req.method} ${c.req.path}` }, 404));
  app.onError((err, c) => c.json({ error: msg(err) }, 500));

  return app;
}
