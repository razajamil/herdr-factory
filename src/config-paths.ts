import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function configDir(): string {
  return process.env.HERDR_FACTORY_CONFIG_DIR?.trim() || join(homedir(), ".config", "herdr-factory");
}

export function stateRoot(): string {
  // Resolve relative overrides because runtime symlinks store their targets verbatim.
  return resolve(process.env.HERDR_FACTORY_STATE_ROOT?.trim() || join(homedir(), ".local", "state", "herdr-factory"));
}

export function repoConfigDir(name: string): string {
  return join(configDir(), "repos", name);
}

export function listConfiguredRepos(): string[] {
  const dir = join(configDir(), "repos");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "config.yml")))
    .map((entry) => entry.name)
    .sort();
}

/** Location advertised by the resident server for lightweight clients such as the TUI. */
export function serverInfoPath(): string {
  return join(stateRoot(), "server.json");
}
