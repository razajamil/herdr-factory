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
  /** The PATH the installed service runs with (baked into the plist/unit); undefined if not
   *  installed / unreadable / unsupported platform. */
  servicePath(): string | undefined;
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
/** The PATH the installed supervisor service runs with, or undefined when there's no readable
 *  service (not installed, or an unsupported platform — so no throw). */
export function servicePath(): string | undefined {
  if (process.platform !== "darwin" && process.platform !== "linux") return undefined;
  return backend().servicePath();
}
