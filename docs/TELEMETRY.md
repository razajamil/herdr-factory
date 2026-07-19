# Telemetry

herdr-factory emits OpenTelemetry traces and metrics when explicitly enabled. Telemetry is off by default so tests and normal local CLI use never try to contact an exporter.

## Local LGTM

Start Grafana's single-container LGTM stack:

```sh
docker compose -f docker-compose.telemetry.yml up
```

Open Grafana at `http://localhost:3000`. The container accepts OTLP over HTTP on `4318` and gRPC on `4317`.

Run a command with telemetry enabled:

```sh
HERDR_FACTORY_TELEMETRY=1 \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
herdr-factory telemetry-smoke
```

In Grafana, open **Explore**, select **Tempo**, and search for service `herdr-factory`. The smoke trace root is `cli.command` and it contains a child span named `telemetry.smoke`.

Run a tick with telemetry enabled:

```sh
HERDR_FACTORY_TELEMETRY=1 \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
herdr-factory --repo <name> tick
```

If a resident server is already running, `tick` routes through that server. In that case the short-lived CLI process emits only the CLI/client spans; the reconciler/server spans come from the resident server process, so restart or reinstall the server with telemetry env set.

With the server running under telemetry, CLI-to-server requests propagate W3C trace context. A routed command should appear as one trace containing both client-side spans (`cli.command`, `http.client.server_fetch`) and server-side spans (`http.server`, `server.tick_repo`, `tick.lock`, `reconcile.repo`, `reconcile.run`, etc.).

Run the resident server directly with telemetry:

```sh
HERDR_FACTORY_TELEMETRY=1 \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
herdr-factory serve
```

For the supervised launchd server, install or start while the telemetry environment is present so those variables are written into the launchd plist:

```sh
HERDR_FACTORY_TELEMETRY=1 \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
herdr-factory install
```

## Environment

- `HERDR_FACTORY_TELEMETRY=1` enables the SDK.
- `OTEL_EXPORTER_OTLP_ENDPOINT` defaults to `http://localhost:4318` when telemetry is enabled.
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` can override the trace URL.
- `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` can override the metrics URL.
- `OTEL_SERVICE_NAME` defaults to `herdr-factory`.
- `OTEL_RESOURCE_ATTRIBUTES` is still honored by the OpenTelemetry SDK for extra resource labels.
- `OTEL_SDK_DISABLED=true` forces telemetry off.

## What Is Emitted

- CLI command spans: `cli.command`.
- Server spans: startup, repo reload, HTTP requests, repo ticks.
- Reconciler spans: repo pass, run pass, phase handlers, claims, teardown.
- Step spans: materialization, prompt rendering, dispatch, spawn.
- Dependency spans: source clients, Herdr, Git, GitHub, subprocess execution, server HTTP client calls.
- Work-source auth gate: `herdr_factory.source_auth_events` (counter, labelled `work.source` + `auth.state` unauthenticated|recovered) — emitted when a source can't authenticate (missing/rejected credentials) and when it recovers.
- Span events mirrored from the existing SQLite domain timeline: `claimed`, `worktree_created`, `step_spawned`, `step_done`, `human_question`, `human_reply`, `pr_opened`, `resolver_woken`, `attention`, `torn_down`, and `error`.

Telemetry does not add rows to the SQLite `events` table. The database timeline remains the product/domain timeline; OpenTelemetry is a separate observer.
