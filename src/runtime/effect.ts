import * as Effect from "effect/Effect";
import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { telemetryEnabled, telemetryMetricExportIntervalMs, telemetryOtlpUrl, telemetryServiceName } from "../telemetry/config.ts";
import { VERSION } from "../version.ts";

const RuntimeLayer = telemetryEnabled()
  ? NodeSdk.layer(() => ({
      resource: { serviceName: telemetryServiceName(), serviceVersion: VERSION },
      spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter({ url: telemetryOtlpUrl("traces") })),
      metricReader: new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: telemetryOtlpUrl("metrics") }),
        exportIntervalMillis: telemetryMetricExportIntervalMs(),
      }),
      shutdownTimeout: 3000,
    }))
  : NodeSdk.layerEmpty;
const runtime = ManagedRuntime.make(RuntimeLayer);

export type AppEffect<A, E = unknown> = Effect.Effect<A, E, never>;

export function runEffect<A, E>(effect: Effect.Effect<A, E, never>): Promise<A> {
  return runtime.runPromise(effect);
}

export async function runEffectPromise<A, E>(effect: Effect.Effect<A, E, never>): Promise<A> {
  const exit = await runtime.runPromiseExit(effect);
  return unwrapExit(exit);
}

export function runEffectSync<A, E>(effect: Effect.Effect<A, E, never>): A {
  return unwrapExit(runtime.runSyncExit(effect));
}

function unwrapExit<A, E>(exit: Exit.Exit<A, E>): A {
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) throw failure.value;
  const error = Cause.prettyErrors(exit.cause)[0];
  throw error ?? new Error(Cause.pretty(exit.cause));
}

export function forkEffect<A, E>(effect: Effect.Effect<A, E, never>) {
  return runtime.runFork(effect);
}

export function disposeEffectRuntime(): Promise<void> {
  return runtime.dispose();
}
