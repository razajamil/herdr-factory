// The Hono OpenAPI app: route definitions (schemas.ts) wired to handlers, plus the OpenAPI JSON
// document (/doc) and Swagger UI (/ui). All resident state + lifecycle lives in serve.ts and is
// injected here via `ServerContext`; this module is pure request → response wiring. Request bodies,
// params and query strings are validated by the route schemas before a handler runs; validation
// failures and thrown errors are normalised to `{ error }` (the shape server/client.ts expects).
import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import * as Effect from "effect/Effect";
import { VERSION } from "../version.ts";
import { withExtractedTelemetryContext } from "../telemetry/index.ts";
import { annotateCurrentSpan, recordHttpServerDurationEffect, withHttpServerSpan } from "../telemetry/effect.ts";
import { runEffect } from "../runtime/effect.ts";
import { bounceStep, claimTicket, reconcileRepo, reconcileRun, recordCaptureAttempt, requestHumanInput, resumeRun, teardownTicket, withRunLock, withRunLockWaiting, withTickLock } from "../core/reconcile.ts";
import { probeEvidenceCreds } from "../clients/evidence.ts";
import { stepByName } from "../core/step.ts";
import { resolveActiveRun, resolveBeltName } from "../resolve.ts";
import type { Deps } from "../core/deps.ts";
import {
  bounceRoute,
  captureAttemptRoute,
  claimRoute,
  askHumanRoute,
  eligibleRoute,
  healthRoute,
  reloadRoute,
  resumeRoute,
  runsRoute,
  shutdownRoute,
  statusRoute,
  stepDoneRoute,
  teardownRoute,
  tickRoute,
  timelineRoute,
} from "./schemas.ts";
import { runHandler } from "./effect.ts";

/** A repo the resident server is currently serving: its injected Deps + tick-loop bookkeeping. */
export interface RepoRuntime {
  deps: Deps;
  timer?: NodeJS.Timeout;
  ticking: boolean;
}

/** The /health payload (also what `ensure-up`/readHealth read back). `tickStale` per repo is the
 *  wedged-tick signal the supervisor restarts on. */
export interface HealthInfo {
  ok: boolean;
  version: string;
  pid: number;
  startedAt: number;
  uptimeSec: number;
  repos: { name: string; active: number; lastTickAt: number | null; tickStale: boolean }[];
}

/** Everything the HTTP layer needs from the resident lifecycle (implemented in serve.ts). */
export interface ServerContext {
  health(): HealthInfo;
  reload(): Promise<{ repos: string[]; failures: { name: string; error: string }[] }>;
  requestShutdown(why: string): void;
  getRepo(name: string): RepoRuntime | undefined;
  knownRepos(): string[];
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Cached AWS creds probe per repo (the dashboard polls /status every ~3s; a HeadBucket must not run
 *  per poll). TTL keeps the light responsive without hammering AWS. */
const SSO_PROBE_TTL_SECONDS = 90;
const ssoProbeCache = new Map<string, { at: number; auth: boolean; reason: string }>();

/** Evidence-upload credential (SSO) health for the dashboard light. `down` when a cached read-only
 *  HeadBucket probe reports a creds/token failure, OR when the outbox already has an auth-stuck upload
 *  (immediate, even between probes). A transient/timeout probe or a permanent bucket/perms error is NOT
 *  "SSO down" (creds are fine — surfaced by doctor). `na` when the repo has no evidence config. */
async function evidenceSsoStatus(rt: RepoRuntime): Promise<{ state: "ok" | "down" | "na"; detail?: string }> {
  const cfg = rt.deps.config;
  const ev = cfg.evidence;
  if (!ev) return { state: "na" };
  if (rt.deps.store.authStuckEvidenceUpload(cfg.repoName)) {
    return { state: "down", detail: `an evidence upload is stuck on expired AWS creds — run \`aws sso login${ev.profile ? ` --profile ${ev.profile}` : ""}\`` };
  }
  const now = rt.deps.now();
  let cached = ssoProbeCache.get(cfg.repoName);
  if (!cached || now - cached.at >= SSO_PROBE_TTL_SECONDS) {
    const probe = await probeEvidenceCreds(ev).catch(() => ({ auth: false, reason: "probe failed" }));
    cached = { at: now, auth: probe.auth, reason: probe.reason };
    ssoProbeCache.set(cfg.repoName, cached);
  }
  return cached.auth ? { state: "down", detail: cached.reason } : { state: "ok" };
}

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
    worker: r.paneId ? await rt.deps.herdr.paneState(r.paneId).catch(() => "unknown") : null,
    steps: rt.deps.store.runStepsFor(r.id).map((s) => ({ step: s.step as string, done: s.done })),
  });
  return {
    repo: cfg.repoName,
    limits: { maxActiveWorkspaces: cfg.limits.maxActiveWorkspaces },
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
    evidenceSso: await evidenceSsoStatus(rt),
  };
}

async function eligiblePayload(rt: RepoRuntime): Promise<{ source: string; key: string; summary: string; type: string }[]> {
  const out: { source: string; key: string; summary: string; type: string }[] = [];
  // Eligibility is per BELT now — each belt polls its source with its own pickup label. Walk belts
  // (not sources) so a label-driven source's items are surfaced under the belt(s) that claim them;
  // dedup by (source, key) since two belts could name the same source (with distinct labels).
  const seen = new Set<string>();
  for (const belt of rt.deps.belts) {
    const src = rt.deps.resolveSource(belt.source);
    if (!src) continue;
    try {
      for (const t of await src.client.listEligible(belt.label)) {
        if (seen.has(`${src.name} ${t.key}`)) continue;
        seen.add(`${src.name} ${t.key}`);
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

  app.use("*", async (c, next) => {
    const startedAt = Date.now();
    const repo = c.req.path.match(/^\/repos\/([^/]+)/)?.[1];
    const decodedRepo = repo ? decodeURIComponent(repo) : undefined;
    return withExtractedTelemetryContext(c.req.raw.headers, () =>
      runEffect(
        withHttpServerSpan(
          {
            "http.request.method": c.req.method,
            "url.path": c.req.path,
            repo: decodedRepo,
          },
          Effect.tryPromise({ try: () => next(), catch: (cause) => cause }).pipe(
            Effect.ensuring(
              Effect.suspend(() =>
                Effect.all([
                  annotateCurrentSpan({ "http.response.status_code": c.res.status }),
                  recordHttpServerDurationEffect(Date.now() - startedAt, {
                    "http.request.method": c.req.method,
                    "http.response.status_code": c.res.status,
                    repo: decodedRepo,
                  }),
                ], { discard: true }),
              ),
            ),
          ),
        ),
      ),
    );
  });

  const notConfigured = (repo: string): string =>
    `repo "${repo}" not configured (server knows: ${ctx.knownRepos().join(", ") || "none"})`;

  // --- server-wide ---------------------------------------------------------
  app.openapi(healthRoute, (c) => runHandler(c, Effect.sync(() => ctx.health()), (health) => c.json(health, 200)));
  app.openapi(reloadRoute, (c) =>
    runHandler(
      c,
      Effect.tryPromise({ try: () => ctx.reload(), catch: (cause) => cause }),
      // ok reflects "every configured repo is actually running" — a repo whose sources failed to
      // construct must not be reported as a clean reload.
      (r) => c.json({ ok: r.failures.length === 0, repos: r.repos, failures: r.failures }, 200),
    ),
  );
  app.openapi(shutdownRoute, (c) =>
    runHandler(
      c,
      Effect.sync(() => {
        // Fire-and-forget: shutdown drains in-flight ticks (up to 15s) before process.exit, leaving
        // ample time for this response to flush first.
        ctx.requestShutdown("http /shutdown");
      }),
      () => c.json({ ok: true }, 200),
    ),
  );

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
    // Per-RUN lock: the nudge lands immediately even while a long tick is mid-pass — it only
    // contends with work on this same run (in which case the flag is already down and the next
    // pass advances it).
    const advanced = await withRunLock(rt.deps, run.id, () => reconcileRun(rt.deps, rt.deps.store.getRun(run.id)!));
    return c.json({ ok: true, advanced }, 200);
  });

  app.openapi(askHumanRoute, async (c) => {
    const { repo } = c.req.valid("param");
    const { key, step, source, question } = c.req.valid("json");
    const rt = ctx.getRepo(repo);
    if (!rt) return c.json({ error: notConfigured(repo) }, 404);
    const run = resolveActiveRun(rt.deps, key, source);
    if (!run) return c.json({ ok: false, message: `${key}: no active run` }, 200);
    const belt = rt.deps.resolveBelt(run.belt);
    if (belt && !stepByName(belt, step)) {
      return c.json({ ok: false, message: `${key}: step "${step}" is not in belt "${belt.name}"` }, 200);
    }
    // Ask-human is a NON-monotonic phase flip (running → waiting_for_human), so it must hold the
    // run lock: a concurrent reconcile on a stale `running` snapshot could advance the step and
    // overwrite the flip, orphaning the question forever.
    const { ran, result } = await withRunLockWaiting(rt.deps, run.id, async () => {
      const res = await requestHumanInput(rt.deps, rt.deps.store.getRun(run.id)!, step, question);
      await reconcileRun(rt.deps, rt.deps.store.getRun(run.id)!);
      return res;
    });
    if (!ran) return c.json({ ok: false, message: `${key}: run busy — retry ask-human in a moment` }, 200);
    return c.json(result!, 200);
  });

  app.openapi(bounceRoute, async (c) => {
    const { repo } = c.req.valid("param");
    const { key, toStep, source, reason } = c.req.valid("json");
    const rt = ctx.getRepo(repo);
    if (!rt) return c.json({ error: notConfigured(repo) }, 404);
    const run = resolveActiveRun(rt.deps, key, source);
    if (!run) return c.json({ ok: false, message: `${key}: no active run` }, 200);
    const belt = rt.deps.resolveBelt(run.belt);
    if (!belt) return c.json({ ok: false, message: `${key}: run has no configured belt` }, 200);
    const src = rt.deps.resolveSource(run.workSource);
    if (!src) return c.json({ ok: false, message: `${key}: run has no configured work source` }, 200);
    // Serialize the bounce (step rewind + pane re-dispatch) against anything else touching this run.
    const { ran, result } = await withRunLockWaiting(rt.deps, run.id, () => bounceStep(rt.deps, rt.deps.store.getRun(run.id)!, belt, src, toStep, reason));
    if (!ran) return c.json({ ok: false, message: `${key}: run busy — retry the bounce` }, 200);
    return c.json(result!, 200);
  });

  app.openapi(captureAttemptRoute, async (c) => {
    const { repo } = c.req.valid("param");
    const { key, step, source } = c.req.valid("json");
    const rt = ctx.getRepo(repo);
    if (!rt) return c.json({ error: notConfigured(repo) }, 404);
    const run = resolveActiveRun(rt.deps, key, source);
    if (!run) return c.json({ ok: false, message: `${key}: no active run` }, 200);
    const belt = rt.deps.resolveBelt(run.belt);
    if (!belt) return c.json({ ok: false, message: `${key}: run has no configured belt` }, 200);
    // Past the cap this parks the run (running → attention) — a non-monotonic flip, so hold the run
    // lock like bounce/ask-human: a concurrent reconcile on a stale `running` snapshot must not
    // overwrite the escalation.
    const { ran, result } = await withRunLockWaiting(rt.deps, run.id, () => recordCaptureAttempt(rt.deps, rt.deps.store.getRun(run.id)!, belt, step));
    if (!ran) return c.json({ ok: false, message: `${key}: run busy — retry the capture-attempt` }, 200);
    return c.json(result!, 200);
  });

  app.openapi(claimRoute, async (c) => {
    const { repo } = c.req.valid("param");
    const { key, belt } = c.req.valid("json");
    const rt = ctx.getRepo(repo);
    if (!rt) return c.json({ error: notConfigured(repo) }, 404);
    await claimTicket(rt.deps, resolveBeltName(rt.deps, belt), key);
    return c.json({ ok: true }, 200);
  });

  app.openapi(resumeRoute, async (c) => {
    const { repo } = c.req.valid("param");
    const { key, source } = c.req.valid("json");
    const rt = ctx.getRepo(repo);
    if (!rt) return c.json({ error: notConfigured(repo) }, 404);
    const run = resolveActiveRun(rt.deps, key, source);
    if (!run) return c.json({ ok: false, message: `${key}: no active run` }, 200);
    // Like bounce: resume mutates the phase and leads straight into a re-dispatch, so it must be
    // serialized against anything else touching this run (a stale snapshot would fight the un-park).
    const { ran, result } = await withRunLockWaiting(rt.deps, run.id, async () => {
      const res = await resumeRun(rt.deps, rt.deps.store.getRun(run.id)!);
      if (res.ok) await reconcileRun(rt.deps, rt.deps.store.getRun(run.id)!);
      return res;
    });
    if (!ran) return c.json({ ok: false, message: `${key}: run busy — retry the resume` }, 200);
    return c.json(result!, 200);
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
