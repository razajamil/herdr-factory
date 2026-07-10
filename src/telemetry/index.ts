import { AsyncLocalStorage } from "node:async_hooks";
import { context, propagation, ROOT_CONTEXT } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import * as Effect from "effect/Effect";
import { runEffect, runEffectPromise, runEffectSync } from "../runtime/effect.ts";
import {
  annotateCurrentSpan,
  recordCliDurationEffect,
  recordDependencyDurationEffect,
  recordDomainEventEffect,
  recordHttpClientDurationEffect,
  recordHttpServerDurationEffect,
  recordRateLimitRemainingEffect,
  recordSourceAuthEventEffect,
  recordTickDurationEffect,
  recordTickEffect,
  recordTickLockSkippedEffect,
  telemetryEventEffect,
  withTelemetrySpan,
} from "./effect.ts";
import { telemetryEnabled as isTelemetryEnabled } from "./config.ts";
export {
  cleanAttributes,
  telemetryEnabled,
  telemetryMetricExportIntervalMs,
  telemetryOtlpUrl,
  telemetryServiceName,
  type TelemetryAttributes,
} from "./config.ts";
import type { TelemetryAttributes } from "./config.ts";

interface BufferedEvent {
  readonly name: string;
  readonly attrs: TelemetryAttributes;
}

interface TelemetryScope {
  readonly attrs: TelemetryAttributes;
  readonly events: BufferedEvent[];
}

export interface TelemetrySpan {
  setAttribute(key: string, value: string | number | boolean | readonly (string | number | boolean)[] | null | undefined): this;
  addEvent(name: string, attrs?: TelemetryAttributes): this;
  recordException(error: unknown): this;
  setStatus(_status: unknown): this;
  end(): void;
}

const scopes = new AsyncLocalStorage<readonly TelemetryScope[]>();

function currentScope(): TelemetryScope | undefined {
  const stack = scopes.getStore();
  return stack?.[stack.length - 1];
}

function runInScope<T>(scope: TelemetryScope, fn: () => T): T {
  return scopes.run([...(scopes.getStore() ?? []), scope], fn);
}

function makeSpan(scope: TelemetryScope): TelemetrySpan {
  return {
    setAttribute(key, value) {
      scope.attrs[key] = value;
      return this;
    },
    addEvent(name, attrs = {}) {
      scope.events.push({ name, attrs });
      return this;
    },
    recordException(error) {
      scope.events.push({
        name: "exception",
        attrs: { "exception.message": error instanceof Error ? error.message : String(error) },
      });
      return this;
    },
    setStatus() {
      return this;
    },
    end() {},
  };
}

function flushScope(scope: TelemetryScope): Effect.Effect<void> {
  return Effect.all(
    [annotateCurrentSpan(scope.attrs), ...scope.events.map((event) => telemetryEventEffect(event.name, event.attrs))],
    { discard: true },
  );
}

function runTelemetry(effect: Effect.Effect<void>): void {
  try {
    runEffectSync(effect);
  } catch {
    void runEffect(effect).catch(() => {});
  }
}

/**
 * Register the OTel global context manager + propagator. THIS IS LOAD-BEARING for span nesting.
 *
 * Our business logic is async/await, not one Effect fiber: every `telemetrySpan`/`withTickLock`/…
 * re-enters the runtime via `runtime.runPromise*`, which starts a FRESH fiber with no Effect
 * parent span. @effect/opentelemetry's tracer then falls back to `context.active()` to find the
 * parent (see OtelSpan `getOtelParent`) — but that only works if a real ContextManager is
 * registered. Without one, `context.active()` is always ROOT_CONTEXT, so every span becomes its
 * own root and traces come out disjointed. The same fallback is what carries the parent across
 * `runEffect` boundaries between the Effect-native spans (server tick loop) and the imperative
 * `telemetrySpan` tree (core reconcile).
 *
 * The propagator additionally powers cross-process tracing: the CLI injects its active span into
 * request headers (injectTelemetryHeaders) and the server re-parents onto it
 * (withExtractedTelemetryContext) — both no-ops without a registered propagator.
 *
 * The pre-`@effect/opentelemetry` implementation got all of this for free from `NodeSDK.start()`,
 * which registers both. `NodeSdk.layer` deliberately does not (Effect apps parent via fibers), so
 * we must register them ourselves. Idempotent + gated on telemetry being enabled.
 */
let propagationRegistered = false;
function registerContextPropagation(): void {
  if (propagationRegistered) return;
  propagationRegistered = true;
  if (!isTelemetryEnabled()) return;
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(
    new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] }),
  );
}

// Register at module load so it is in place before the first span, regardless of entry point
// (CLI, serve, TUI). initTelemetry() below also calls it as the explicit, named init hook.
registerContextPropagation();

export function initTelemetry(): boolean {
  registerContextPropagation();
  return isTelemetryEnabled();
}

export async function shutdownTelemetry(): Promise<void> {}

export function injectTelemetryHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const carrier = { ...headers };
  propagation.inject(context.active(), carrier);
  return carrier;
}

export function withExtractedTelemetryContext<T>(headers: Headers, fn: () => T): T {
  const carrier: Record<string, string> = {};
  headers.forEach((value, key) => {
    carrier[key] = value;
  });
  const extracted = propagation.extract(context.active(), carrier);
  return context.with(extracted, fn);
}

export function withRootTelemetryContext<T>(fn: () => T): T {
  return context.with(ROOT_CONTEXT, fn);
}

export async function telemetrySpan<T>(name: string, attrs: TelemetryAttributes, fn: (span: TelemetrySpan) => Promise<T> | T): Promise<T> {
  const scope: TelemetryScope = { attrs: {}, events: [] };
  const span = makeSpan(scope);
  return runEffectPromise(
    withTelemetrySpan(
      name,
      attrs,
      Effect.tryPromise({ try: () => runInScope(scope, () => Promise.resolve(fn(span))), catch: (cause) => cause }).pipe(
        Effect.ensuring(Effect.suspend(() => flushScope(scope))),
      ),
    ),
  );
}

export function telemetrySpanSync<T>(name: string, attrs: TelemetryAttributes, fn: (span: TelemetrySpan) => T): T {
  const scope: TelemetryScope = { attrs: {}, events: [] };
  const span = makeSpan(scope);
  return runEffectSync(
    withTelemetrySpan(
      name,
      attrs,
      Effect.try({ try: () => runInScope(scope, () => fn(span)), catch: (cause) => cause }).pipe(
        Effect.ensuring(Effect.suspend(() => flushScope(scope))),
      ),
    ),
  );
}

export function telemetryEvent(name: string, attrs: TelemetryAttributes = {}): void {
  const scope = currentScope();
  if (scope) {
    scope.events.push({ name, attrs });
    return;
  }
  runTelemetry(telemetryEventEffect(name, attrs));
}

export function setTelemetryAttributes(attrs: TelemetryAttributes): void {
  const scope = currentScope();
  if (scope) {
    Object.assign(scope.attrs, attrs);
    return;
  }
  runTelemetry(annotateCurrentSpan(attrs));
}

export function recordCliDuration(ms: number, attrs: TelemetryAttributes = {}): void {
  runTelemetry(recordCliDurationEffect(ms, attrs));
}

export function recordHttpServerDuration(ms: number, attrs: TelemetryAttributes = {}): void {
  runTelemetry(recordHttpServerDurationEffect(ms, attrs));
}

export function recordHttpClientDuration(ms: number, attrs: TelemetryAttributes = {}): void {
  runTelemetry(recordHttpClientDurationEffect(ms, attrs));
}

export function recordTickDuration(ms: number, attrs: TelemetryAttributes = {}): void {
  runTelemetry(recordTickDurationEffect(ms, attrs));
}

export function recordDependencyDuration(ms: number, attrs: TelemetryAttributes = {}): void {
  runTelemetry(recordDependencyDurationEffect(ms, attrs));
}

export function recordDomainEvent(type: string, attrs: TelemetryAttributes = {}): void {
  runTelemetry(recordDomainEventEffect(type, attrs));
}

export function recordTick(ran: boolean, attrs: TelemetryAttributes = {}): void {
  runTelemetry(recordTickEffect(ran, attrs));
}

export function recordTickLockSkipped(attrs: TelemetryAttributes = {}): void {
  runTelemetry(recordTickLockSkippedEffect(attrs));
}

export function recordRateLimitRemaining(remaining: number, attrs: TelemetryAttributes = {}): void {
  runTelemetry(recordRateLimitRemainingEffect(remaining, attrs));
}

export function recordSourceAuthEvent(attrs: TelemetryAttributes = {}): void {
  runTelemetry(recordSourceAuthEventEffect(attrs));
}

export function instrumentObject<T extends object>(target: T, prefix: string, attrs: TelemetryAttributes = {}): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver) as unknown;
      if (typeof prop !== "string" || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const startedAt = Date.now();
        const methodAttrs = { ...attrs, "dependency.name": prefix, "dependency.method": prop };
        return telemetrySpan(`${prefix}.${prop}`, methodAttrs, async () => {
          try {
            return await value.apply(obj, args);
          } finally {
            recordDependencyDuration(Date.now() - startedAt, methodAttrs);
          }
        });
      };
    },
  }) as T;
}
