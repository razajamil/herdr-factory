import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../clients/exec.ts";
import { listConfiguredRepos, resolvedNodePath, serverLogsDir } from "../config.ts";

const PKG_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI_ENTRY = join(PKG_ROOT, "src", "cli", "index.ts");

// ONE repo-agnostic supervisor job for the whole machine — it runs `ensure-up`, which keeps the
// single resident `serve` process (serving every configured repo) alive. This replaces the old
// per-repo `com.herdr-factory.<repo>` `watch` jobs.
const LABEL = "com.herdr-factory.server";
const PASSTHROUGH_ENV = [
  "HERDR_FACTORY_AUTO_UPDATE",
  "HERDR_FACTORY_TELEMETRY",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_SERVICE_NAME",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_METRIC_EXPORT_INTERVAL",
  "OTEL_SDK_DISABLED",
] as const;

export function label(): string {
  return LABEL;
}
function legacyLabel(repo: string): string {
  return `com.herdr-factory.${repo}`;
}
function plistFile(lbl: string): string {
  return join(homedir(), "Library", "LaunchAgents", `${lbl}.plist`);
}
function domain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function xmlUnescape(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** The PATH baked into the installed plist — i.e. the environment the supervisor and the resident
 *  `serve` resolve tools in. Undefined if the plist is absent (service not installed) or unreadable.
 *  Used by the doctor so a run from a leaner context (a GUI-launched TUI) checks tool presence
 *  against where the work actually happens, not its own PATH. */
export function servicePath(): string | undefined {
  const file = plistFile(LABEL);
  if (!existsSync(file)) return undefined;
  try {
    // plistXml emits `<key>PATH</key><string>…</string>` on one line; the value is xml-escaped, so
    // it contains no literal '<' and `[^<]*` captures it whole.
    const value = readFileSync(file, "utf8").match(/<key>PATH<\/key>\s*<string>([^<]*)<\/string>/)?.[1];
    return value === undefined ? undefined : xmlUnescape(value);
  } catch {
    return undefined;
  }
}

function passthroughEnvXml(): string {
  return PASSTHROUGH_ENV
    .map((key) => {
      const value = process.env[key]?.trim();
      return value ? `    <key>${key}</key><string>${xmlEscape(value)}</string>` : "";
    })
    .filter(Boolean)
    .join("\n");
}

function plistXml(): string {
  const logs = serverLogsDir();
  const telemetryEnv = passthroughEnvXml();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>WorkingDirectory</key><string>${PKG_ROOT}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(resolvedNodePath(process.execPath))}</string>
    <string>${CLI_ENTRY}</string>
    <string>ensure-up</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xmlEscape(process.env.PATH ?? "")}</string>
    <key>HOME</key><string>${xmlEscape(homedir())}</string>
${telemetryEnv ? `${telemetryEnv}\n` : ""}  </dict>
  <!-- Stateless supervisor: 'ensure-up' is a ONE-SHOT that (re)starts the resident 'serve'
       process if it's down/wedged/outdated, then exits. StartInterval re-runs it on a schedule.
       Because the supervised command is a one-shot (not a resident loop), it is itself immune to
       the per-user launchd interval wedging that bites a KeepAlive resident after sleep/wake —
       and 'serve' self-sustains between runs, so a missed beat is harmless. -->
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${join(logs, "supervisor.out.log")}</string>
  <key>StandardErrorPath</key><string>${join(logs, "supervisor.err.log")}</string>
</dict>
</plist>
`;
}

async function bootout(lbl: string): Promise<void> {
  await run("launchctl", ["bootout", `${domain()}/${lbl}`], { allowFail: true });
}
async function bootstrap(): Promise<void> {
  await run("launchctl", ["bootstrap", domain(), plistFile(LABEL)]);
}

/** Remove any legacy per-repo `com.herdr-factory.<repo>` watch jobs (the pre-server model), so an
 *  upgrade doesn't leave both models running. Scoped to currently-configured repos. */
async function bootoutLegacy(): Promise<void> {
  for (const repo of listConfiguredRepos()) {
    const lbl = legacyLabel(repo);
    const file = plistFile(lbl);
    if (existsSync(file)) {
      await bootout(lbl);
      rmSync(file);
    }
  }
}

export async function install(): Promise<void> {
  mkdirSync(serverLogsDir(), { recursive: true });
  await bootoutLegacy();
  const file = plistFile(LABEL);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, plistXml());
  await bootout(LABEL);
  await bootstrap();
}
export async function uninstall(): Promise<void> {
  await bootout(LABEL);
  const file = plistFile(LABEL);
  if (existsSync(file)) rmSync(file);
}
export async function start(): Promise<void> {
  if (!existsSync(plistFile(LABEL))) {
    await install();
    return;
  }
  await bootout(LABEL);
  await bootstrap();
}
export async function stop(): Promise<void> {
  await bootout(LABEL);
}
export async function isLoaded(): Promise<boolean> {
  const r = await run("launchctl", ["list"], { allowFail: true });
  return r.stdout.includes(LABEL);
}
