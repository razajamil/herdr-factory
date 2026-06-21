import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./clients/exec.ts";
import type { Config } from "./config.ts";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_ENTRY = join(PKG_ROOT, "src", "cli.ts");

export function label(repo: string): string {
  return `com.herdr-factory.${repo}`;
}
function plistFile(repo: string): string {
  return join(homedir(), "Library", "LaunchAgents", `${label(repo)}.plist`);
}
function domain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

function plistXml(config: Config): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label(config.repoName)}</string>
  <key>WorkingDirectory</key><string>${PKG_ROOT}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${CLI_ENTRY}</string>
    <string>--repo</string><string>${config.repoName}</string>
    <string>watch</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${process.env.PATH ?? ""}</string>
    <key>HOME</key><string>${homedir()}</string>
  </dict>
  <!-- Resident daemon: \`watch\` loops every tick_interval_seconds itself. KeepAlive (not
       StartInterval) restarts it if it ever dies, and the internal loop is immune to the
       per-user launchd interval-timer wedging that StartInterval is prone to after sleep. -->
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${join(config.paths.logsDir, "launchd.out.log")}</string>
  <key>StandardErrorPath</key><string>${join(config.paths.logsDir, "launchd.err.log")}</string>
</dict>
</plist>
`;
}

async function bootout(repo: string): Promise<void> {
  await run("launchctl", ["bootout", `${domain()}/${label(repo)}`], { allowFail: true });
}
async function bootstrap(repo: string): Promise<void> {
  await run("launchctl", ["bootstrap", domain(), plistFile(repo)]);
}

export async function install(config: Config): Promise<void> {
  mkdirSync(config.paths.logsDir, { recursive: true });
  const file = plistFile(config.repoName);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, plistXml(config));
  await bootout(config.repoName);
  await bootstrap(config.repoName);
}
export async function uninstall(repo: string): Promise<void> {
  await bootout(repo);
  const file = plistFile(repo);
  if (existsSync(file)) rmSync(file);
}
export async function start(config: Config): Promise<void> {
  if (!existsSync(plistFile(config.repoName))) {
    await install(config);
    return;
  }
  await bootout(config.repoName);
  await bootstrap(config.repoName);
}
export async function stop(repo: string): Promise<void> {
  await bootout(repo);
}
export async function isLoaded(repo: string): Promise<boolean> {
  const r = await run("launchctl", ["list"], { allowFail: true });
  return r.stdout.includes(label(repo));
}
