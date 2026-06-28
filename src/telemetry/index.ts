import { context, metrics, propagation, ROOT_CONTEXT, SpanStatusCode, trace, type AttributeValue, type Attributes, type Span } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { VERSION } from "../version.ts";

type AttributePrimitive = string | number | boolean;
export type TelemetryAttributes = Record<string, AttributePrimitive | readonly AttributePrimitive[] | null | undefined>;

const SERVICE_NAME = "herdr-factory";
const INSTRUMENTATION_NAME = "herdr-factory";

let sdk: NodeSDK | undefined;
let started = false;
let shuttingDown: Promise<void> | undefined;

function isTruthy(v: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((v ?? "").trim().toLowerCase());
}

function isDisabled(v: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((v ?? "").trim().toLowerCase());
}

export function telemetryEnabled(): boolean {
  if (isDisabled(process.env.OTEL_SDK_DISABLED)) return false;
  return isTruthy(process.env.HERDR_FACTORY_TELEMETRY);
}

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

function otlpUrl(kind: "traces" | "metrics"): string {
  const specific = kind === "traces" ? process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT : process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
  if (specific?.trim()) return specific.trim();
  const base = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || "http://localhost:4318").replace(/\/+$/, "");
  return `${base}/v1/${kind}`;
}

function metricExportIntervalMs(): number {
  const n = Number(process.env.OTEL_METRIC_EXPORT_INTERVAL);
  return Number.isFinite(n) && n > 0 ? n : 10_000;
}

export function initTelemetry(): boolean {
  if (started) return true;
  if (!telemetryEnabled()) return false;
  try {
    const serviceName = process.env.OTEL_SERVICE_NAME?.trim() || SERVICE_NAME;
    sdk = new NodeSDK({
      autoDetectResources: false,
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: serviceName,
        [ATTR_SERVICE_VERSION]: VERSION,
      }),
      traceExporter: new OTLPTraceExporter({ url: otlpUrl("traces") }),
      metricReaders: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: otlpUrl("metrics") }),
          exportIntervalMillis: metricExportIntervalMs(),
        }),
      ],
    });
    sdk.start();
    started = true;
    return true;
  } catch (e) {
    process.stderr.write(`telemetry disabled: ${e instanceof Error ? e.message : String(e)}\n`);
    sdk = undefined;
    started = false;
    return false;
  }
}

export async function shutdownTelemetry(timeoutMs = 3000): Promise<void> {
  if (!started || !sdk) return;
  if (!shuttingDown) {
    const shutdown = sdk.shutdown();
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
    shuttingDown = Promise.race([shutdown, timeout])
      .catch((e) => {
        process.stderr.write(`telemetry shutdown failed: ${e instanceof Error ? e.message : String(e)}\n`);
      })
      .finally(() => {
        started = false;
        sdk = undefined;
        shuttingDown = undefined;
      });
  }
  await shuttingDown;
}

export function cleanAttributes(attrs: TelemetryAttributes = {}): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    const clean: AttributeValue = Array.isArray(value)
      ? cleanAttributeArray(value as readonly AttributePrimitive[])
      : (value as AttributePrimitive);
    out[key] = clean;
  }
  return out;
}

function cleanAttributeArray(value: readonly AttributePrimitive[]): AttributeValue {
  if (value.every((v) => typeof v === "string")) return [...value] as string[];
  if (value.every((v) => typeof v === "number")) return [...value] as number[];
  if (value.every((v) => typeof v === "boolean")) return [...value] as boolean[];
  return value.map(String);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function recordSpanError(span: Span, e: unknown): void {
  if (e instanceof Error) span.recordException(e);
  else span.recordException(String(e));
  span.setStatus({ code: SpanStatusCode.ERROR, message: msg(e) });
}

export async function telemetrySpan<T>(
  name: string,
  attrs: TelemetryAttributes,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  const tracer = trace.getTracer(INSTRUMENTATION_NAME, VERSION);
  const span = tracer.startSpan(name, { attributes: cleanAttributes(attrs) });
  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (e) {
      recordSpanError(span, e);
      throw e;
    } finally {
      span.end();
    }
  });
}

export function telemetrySpanSync<T>(name: string, attrs: TelemetryAttributes, fn: (span: Span) => T): T {
  const tracer = trace.getTracer(INSTRUMENTATION_NAME, VERSION);
  const span = tracer.startSpan(name, { attributes: cleanAttributes(attrs) });
  return context.with(trace.setSpan(context.active(), span), () => {
    try {
      const result = fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (e) {
      recordSpanError(span, e);
      throw e;
    } finally {
      span.end();
    }
  });
}

export function telemetryEvent(name: string, attrs: TelemetryAttributes = {}): void {
  trace.getActiveSpan()?.addEvent(name, cleanAttributes(attrs));
}

export function setTelemetryAttributes(attrs: TelemetryAttributes): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  for (const [key, value] of Object.entries(cleanAttributes(attrs))) {
    if (value !== undefined) span.setAttribute(key, value);
  }
}

const meter = metrics.getMeter(INSTRUMENTATION_NAME, VERSION);
const cliDuration = meter.createHistogram("herdr_factory.cli.command.duration_ms", { unit: "ms" });
const httpServerDuration = meter.createHistogram("herdr_factory.http.server.duration_ms", { unit: "ms" });
const httpClientDuration = meter.createHistogram("herdr_factory.http.client.duration_ms", { unit: "ms" });
const tickDuration = meter.createHistogram("herdr_factory.tick.duration_ms", { unit: "ms" });
const dependencyDuration = meter.createHistogram("herdr_factory.dependency.duration_ms", { unit: "ms" });
const domainEvents = meter.createCounter("herdr_factory.domain_events", { unit: "1" });
const attentionEvents = meter.createCounter("herdr_factory.attention_events", { unit: "1" });
const tickLocksSkipped = meter.createCounter("herdr_factory.tick.lock_skipped", { unit: "1" });
const ticks = meter.createCounter("herdr_factory.ticks", { unit: "1" });

export function recordCliDuration(ms: number, attrs: TelemetryAttributes = {}): void {
  cliDuration.record(ms, cleanAttributes(attrs));
}

export function recordHttpServerDuration(ms: number, attrs: TelemetryAttributes = {}): void {
  httpServerDuration.record(ms, cleanAttributes(attrs));
}

export function recordHttpClientDuration(ms: number, attrs: TelemetryAttributes = {}): void {
  httpClientDuration.record(ms, cleanAttributes(attrs));
}

export function recordTickDuration(ms: number, attrs: TelemetryAttributes = {}): void {
  tickDuration.record(ms, cleanAttributes(attrs));
}

export function recordDependencyDuration(ms: number, attrs: TelemetryAttributes = {}): void {
  dependencyDuration.record(ms, cleanAttributes(attrs));
}

export function recordDomainEvent(type: string, attrs: TelemetryAttributes = {}): void {
  const clean = { ...attrs, "event.type": type };
  domainEvents.add(1, cleanAttributes(clean));
  if (type === "attention") attentionEvents.add(1, cleanAttributes(clean));
}

export function recordTick(ran: boolean, attrs: TelemetryAttributes = {}): void {
  ticks.add(1, cleanAttributes({ ...attrs, "tick.ran": ran }));
}

export function recordTickLockSkipped(attrs: TelemetryAttributes = {}): void {
  tickLocksSkipped.add(1, cleanAttributes(attrs));
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
