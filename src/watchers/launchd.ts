import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../clients/exec.ts";
import { listConfiguredRepos, serverLogsDir } from "../config.ts";

const PKG_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI_ENTRY = join(PKG_ROOT, "src", "cli", "index.ts");

// ONE repo-agnostic supervisor job for the whole machine — it runs `ensure-up`, which keeps the
// single resident `serve` process (serving every configured repo) alive. This replaces the old
// per-repo `com.herdr-factory.<repo>` `watch` jobs.
const LABEL = "com.herdr-factory.server";

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

function plistXml(): string {
  const logs = serverLogsDir();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>WorkingDirectory</key><string>${PKG_ROOT}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${CLI_ENTRY}</string>
    <string>ensure-up</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${process.env.PATH ?? ""}</string>
    <key>HOME</key><string>${homedir()}</string>
  </dict>
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
