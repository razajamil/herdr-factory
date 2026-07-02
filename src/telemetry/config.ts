type AttributePrimitive = string | number | boolean;
export type TelemetryAttributes = Record<string, AttributePrimitive | readonly AttributePrimitive[] | null | undefined>;
export type CleanTelemetryAttributes = Record<string, AttributePrimitive | readonly AttributePrimitive[]>;

const SERVICE_NAME = "herdr-factory";

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

export function telemetryOtlpUrl(kind: "traces" | "metrics"): string {
  const specific = kind === "traces" ? process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT : process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
  if (specific?.trim()) return specific.trim();
  const base = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || "http://localhost:4318").replace(/\/+$/, "");
  return `${base}/v1/${kind}`;
}

export function telemetryServiceName(): string {
  return process.env.OTEL_SERVICE_NAME?.trim() || SERVICE_NAME;
}

export function telemetryMetricExportIntervalMs(): number {
  const n = Number(process.env.OTEL_METRIC_EXPORT_INTERVAL);
  return Number.isFinite(n) && n > 0 ? n : 10_000;
}

export function cleanAttributes(attrs: TelemetryAttributes = {}): CleanTelemetryAttributes {
  const out: CleanTelemetryAttributes = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    out[key] = Array.isArray(value) ? cleanAttributeArray(value as readonly AttributePrimitive[]) : (value as AttributePrimitive);
  }
  return out;
}

function cleanAttributeArray(value: readonly AttributePrimitive[]): readonly AttributePrimitive[] {
  if (value.every((v) => typeof v === "string")) return [...value] as string[];
  if (value.every((v) => typeof v === "number")) return [...value] as number[];
  if (value.every((v) => typeof v === "boolean")) return [...value] as boolean[];
  return value.map(String);
}
