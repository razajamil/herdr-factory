import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import * as MetricBoundaries from "effect/MetricBoundaries";
import * as MetricLabel from "effect/MetricLabel";
import { cleanAttributes, type TelemetryAttributes } from "./config.ts";

const durationBoundaries = MetricBoundaries.exponential({ start: 1, factor: 2, count: 16 });

const cliDuration = Metric.histogram("herdr_factory.cli.command.duration_ms", durationBoundaries, "CLI command duration in milliseconds");
const tickDuration = Metric.histogram("herdr_factory.tick.duration_ms", durationBoundaries, "Tick duration in milliseconds");
const dependencyDuration = Metric.histogram("herdr_factory.dependency.duration_ms", durationBoundaries, "Dependency call duration in milliseconds");
const domainEvents = Metric.counter("herdr_factory.domain_events", { incremental: true });
const attentionEvents = Metric.counter("herdr_factory.attention_events", { incremental: true });
const tickLocksSkipped = Metric.counter("herdr_factory.tick.lock_skipped", { incremental: true });
const ticks = Metric.counter("herdr_factory.ticks", { incremental: true });

const sourceAuthEvents = Metric.counter("herdr_factory.source_auth_events", {
  incremental: true,
  description: "Work-source auth-gate transitions (labelled work.source + auth.state unauthenticated|recovered)",
});

const oauthEvents = Metric.counter("herdr_factory.oauth_events", {
  incremental: true,
  description: "Jira OAuth lifecycle outcomes (labelled oauth.phase login|token_exchange|token_refresh|whoami|broker_forward + oauth.outcome ok|error)",
});

const rateLimitRemaining = Metric.gauge("herdr_factory.rate_limit.remaining", { description: "Backend-reported rate-limit remaining (per backend label)" });
const rateLimitWaitMs = Metric.histogram(
  "herdr_factory.rate_limit.wait_ms",
  durationBoundaries,
  "Time spent waiting on a client-side token bucket in milliseconds",
);

const httpServerDuration = Metric.histogram(
  "herdr_factory.http.server.duration_ms",
  durationBoundaries,
  "HTTP server request duration in milliseconds",
);
const httpClientDuration = Metric.histogram(
  "herdr_factory.http.client.duration_ms",
  durationBoundaries,
  "HTTP client request duration in milliseconds",
);

function metricLabels(attrs: TelemetryAttributes): MetricLabel.MetricLabel[] {
  return Object.entries(cleanAttributes(attrs)).map(([key, value]) =>
    MetricLabel.make(key, Array.isArray(value) ? value.join(",") : String(value)),
  );
}

export function annotateCurrentSpan(attrs: TelemetryAttributes): Effect.Effect<void> {
  return Effect.annotateCurrentSpan(cleanAttributes(attrs));
}

export function recordHttpServerDurationEffect(ms: number, attrs: TelemetryAttributes = {}): Effect.Effect<void> {
  return Metric.update(Metric.taggedWithLabels(httpServerDuration, metricLabels(attrs)), ms);
}

export function recordHttpClientDurationEffect(ms: number, attrs: TelemetryAttributes = {}): Effect.Effect<void> {
  return Metric.update(Metric.taggedWithLabels(httpClientDuration, metricLabels(attrs)), ms);
}

export function recordCliDurationEffect(ms: number, attrs: TelemetryAttributes = {}): Effect.Effect<void> {
  return Metric.update(Metric.taggedWithLabels(cliDuration, metricLabels(attrs)), ms);
}

export function recordTickDurationEffect(ms: number, attrs: TelemetryAttributes = {}): Effect.Effect<void> {
  return Metric.update(Metric.taggedWithLabels(tickDuration, metricLabels(attrs)), ms);
}

export function recordDependencyDurationEffect(ms: number, attrs: TelemetryAttributes = {}): Effect.Effect<void> {
  return Metric.update(Metric.taggedWithLabels(dependencyDuration, metricLabels(attrs)), ms);
}

export function recordDomainEventEffect(type: string, attrs: TelemetryAttributes = {}): Effect.Effect<void> {
  const labels = metricLabels({ ...attrs, "event.type": type });
  const recordDomain = Metric.increment(Metric.taggedWithLabels(domainEvents, labels));
  if (type !== "attention") return recordDomain;
  return Effect.all([recordDomain, Metric.increment(Metric.taggedWithLabels(attentionEvents, labels))], { discard: true });
}

export function recordTickEffect(ran: boolean, attrs: TelemetryAttributes = {}): Effect.Effect<void> {
  return Metric.increment(Metric.taggedWithLabels(ticks, metricLabels({ ...attrs, "tick.ran": ran })));
}

export function recordTickLockSkippedEffect(attrs: TelemetryAttributes = {}): Effect.Effect<void> {
  return Metric.increment(Metric.taggedWithLabels(tickLocksSkipped, metricLabels(attrs)));
}

export function recordRateLimitRemainingEffect(remaining: number, attrs: TelemetryAttributes = {}): Effect.Effect<void> {
  return Metric.update(Metric.taggedWithLabels(rateLimitRemaining, metricLabels(attrs)), remaining);
}

export function recordSourceAuthEventEffect(attrs: TelemetryAttributes = {}): Effect.Effect<void> {
  return Metric.increment(Metric.taggedWithLabels(sourceAuthEvents, metricLabels(attrs)));
}

export function recordOAuthEventEffect(attrs: TelemetryAttributes = {}): Effect.Effect<void> {
  return Metric.increment(Metric.taggedWithLabels(oauthEvents, metricLabels(attrs)));
}

export function recordRateLimitWaitEffect(ms: number, attrs: TelemetryAttributes = {}): Effect.Effect<void> {
  return Metric.update(Metric.taggedWithLabels(rateLimitWaitMs, metricLabels(attrs)), ms);
}

export function telemetryEventEffect(name: string, attrs: TelemetryAttributes = {}): Effect.Effect<void> {
  return Effect.currentSpan.pipe(
    Effect.flatMap((span) => Effect.sync(() => span.event(name, BigInt(Date.now()) * BigInt(1_000_000), cleanAttributes(attrs)))),
    Effect.catchAll(() => Effect.succeed(undefined)),
  );
}

export function withTelemetrySpan<A, E, R>(
  name: string,
  attrs: TelemetryAttributes,
  effect: Effect.Effect<A, E, R>,
  kind: "internal" | "server" | "client" | "producer" | "consumer" = "internal",
): Effect.Effect<A, E, R> {
  return effect.pipe(Effect.withSpan(name, { attributes: cleanAttributes(attrs), kind }));
}

export function withHttpServerSpan<A, E, R>(attrs: TelemetryAttributes, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return withTelemetrySpan("http.server", attrs, effect, "server");
}
