// Platform dispatch for the machine-wide supervisor service: launchd on macOS, systemd --user on
// Linux. The CLI (install/uninstall/start/stop/status) talks to this, never the OS module directly,
// so adding a platform is a change in one place. Both backends run the same stateless `ensure-up`
// one-shot on a 60s cadence and invoke node via the baked runtime path.
import * as launchd from "./launchd.ts";
import * as systemd from "./systemd.ts";

interface ServiceBackend {
  label(): string;
  install(): Promise<void>;
  uninstall(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  isLoaded(): Promise<boolean>;
}

function backend(): ServiceBackend {
  if (process.platform === "darwin") return launchd;
  if (process.platform === "linux") return systemd;
  throw new Error(`no supervisor service for ${process.platform} (macOS launchd / Linux systemd only)`);
}

export function label(): string {
  return backend().label();
}
export function install(): Promise<void> {
  return backend().install();
}
export function uninstall(): Promise<void> {
  return backend().uninstall();
}
export function start(): Promise<void> {
  return backend().start();
}
export function stop(): Promise<void> {
  return backend().stop();
}
export function isLoaded(): Promise<boolean> {
  return backend().isLoaded();
}
