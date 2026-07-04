// Vendored Node runtime provisioner. Downloads the pinned official Node build (see .node-version)
// for THIS platform into `<state>/runtime/<version>/` and flips the stable `<state>/runtime/current`
// symlink at it, so a `curl | install.sh` install needs no pre-installed Node and a `.node-version`
// bump propagates to installed machines automatically (the self-updater calls provisionNode() when
// it sees .node-version change — see updater.ts). A plain dev checkout never calls this: it runs on
// the ambient node.
//
// Trust root: the tarball's SHA-256 is checked against the official SHASUMS256.txt (fetched over
// TLS from the same host). A GPG signature check is layered on best-effort when gpg + the Node
// release keys are available, but the SHA gate is mandatory — a mismatch aborts.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { run } from "../clients/exec.ts";
import { managedNodePath, nodePathFile, runtimeCurrentLink, runtimeRoot, runtimeVersionDir } from "../config.ts";
import { recordDependencyDuration, telemetrySpan } from "../telemetry/index.ts";
import type { Log } from "./supervisor.ts";

const PKG_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface ProvisionResult {
  version: string;
  changed: boolean; // did the `current` symlink / node-path actually move?
  nodePath: string; // the stable managed node path
  reason?: string;
}

/** The pinned Node version from THIS package's `.node-version` (resolved against the package dir,
 *  never the caller's cwd). Trimmed; a leading `v` is tolerated. */
export function pinnedNodeVersion(): string {
  const raw = readFileSync(join(PKG_ROOT, ".node-version"), "utf8").trim();
  return raw.replace(/^v/, "");
}

interface Platform {
  os: "darwin" | "linux";
  arch: "x64" | "arm64";
  libc: "glibc" | "musl";
}

/** Resolve the current platform to the pieces of an official Node dist filename. Windows is not
 *  supported here yet (its service model differs); provisionNode throws for it. */
export function detectPlatform(): Platform {
  const arch = process.arch;
  if (arch !== "x64" && arch !== "arm64") throw new Error(`unsupported arch for vendored Node: ${arch}`);
  if (process.platform === "darwin") return { os: "darwin", arch, libc: "glibc" };
  if (process.platform === "linux") return { os: "linux", arch, libc: detectLibc() };
  throw new Error(`unsupported platform for vendored Node: ${process.platform} (Windows install is a separate path)`);
}

/** glibc vs musl. Node's own report carries glibcVersionRuntime on a glibc build and omits it on
 *  musl; fall back to probing the musl loader path. */
function detectLibc(): "glibc" | "musl" {
  try {
    const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
    if (header && "glibcVersionRuntime" in header && header.glibcVersionRuntime) return "glibc";
  } catch {
    /* fall through to the filesystem probe */
  }
  if (existsSync("/lib/ld-musl-x86_64.so.1") || existsSync("/lib/ld-musl-aarch64.so.1")) return "musl";
  return "glibc";
}

interface DistInfo {
  base: string; // dir URL holding the tarball + SHASUMS256.txt
  file: string; // tarball filename (also its key in SHASUMS256.txt)
  dirName: string; // the top-level dir inside the tarball
}

/** Where to fetch the official (or unofficial-builds, for musl) Node tarball for a platform. We use
 *  .tar.gz everywhere so a stock `tar -xzf` works without an xz dependency. */
function distInfo(version: string, p: Platform): DistInfo {
  const v = `v${version}`;
  if (p.libc === "musl") {
    const dirName = `node-${v}-linux-${p.arch}-musl`;
    return { base: `https://unofficial-builds.nodejs.org/download/release/${v}`, file: `${dirName}.tar.gz`, dirName };
  }
  const dirName = `node-${v}-${p.os}-${p.arch}`;
  return { base: `https://nodejs.org/dist/${v}`, file: `${dirName}.tar.gz`, dirName };
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  return res.text();
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dest));
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/** Mandatory SHA-256 gate: the downloaded tarball must match its line in SHASUMS256.txt. */
async function verifyChecksum(tarball: string, info: DistInfo): Promise<void> {
  const sums = await fetchText(`${info.base}/SHASUMS256.txt`);
  const line = sums.split("\n").find((l) => l.trim().endsWith(` ${info.file}`) || l.trim().endsWith(`*${info.file}`) || l.trim().endsWith(info.file));
  const expected = line?.trim().split(/\s+/)[0]?.toLowerCase();
  if (!expected) throw new Error(`no SHASUMS256 entry for ${info.file}`);
  const actual = (await sha256File(tarball)).toLowerCase();
  if (actual !== expected) throw new Error(`checksum mismatch for ${info.file}: expected ${expected}, got ${actual}`);
}

/** Best-effort GPG provenance check on top of the SHA gate. Silently skipped when gpg is missing or
 *  the Node release keys are not imported — the SHA gate is the hard requirement. */
async function verifySignatureBestEffort(info: DistInfo, tarball: string, log: Log): Promise<void> {
  const dir = dirname(tarball);
  const shaFile = join(dir, `SHASUMS256.txt.${process.pid}`);
  const ascFile = `${shaFile}.asc`;
  try {
    await run("gpg", ["--version"]); // gpg present?
    writeFileSync(shaFile, await fetchText(`${info.base}/SHASUMS256.txt`));
    writeFileSync(ascFile, await fetchText(`${info.base}/SHASUMS256.txt.asc`));
    const r = await run("gpg", ["--verify", ascFile, shaFile], { allowFail: true });
    if (r.code === 0) log("info", "provision: GPG signature verified");
    else log("info", "provision: GPG signature not verified (release keys not imported) — relying on SHA-256 gate");
  } catch {
    /* gpg unavailable or .asc missing (unofficial-builds) — SHA-256 gate already passed */
  } finally {
    for (const f of [shaFile, ascFile]) {
      try {
        rmSync(f, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

/** Point `<state>/runtime/current` at `versionDir` atomically (write a sibling symlink, then
 *  rename over the old one — a rename of a symlink is atomic on POSIX). Returns whether it moved. */
function flipCurrent(versionDir: string): boolean {
  const link = runtimeCurrentLink();
  let current: string | null = null;
  try {
    current = readlinkSync(link); // the symlink's target path (throws if the link is absent)
  } catch {
    current = null;
  }
  if (current === versionDir) return false;
  const tmp = `${link}.${process.pid}`;
  try {
    rmSync(tmp, { force: true });
  } catch {
    /* ignore */
  }
  symlinkSync(versionDir, tmp);
  renameSync(tmp, link);
  return true;
}

/** Ensure the pinned Node for `version` is present under `<state>/runtime/<version>` and that
 *  `current` + the node-path file point at it. Idempotent: a second call for an already-installed
 *  version only fixes up the symlink. */
export async function provisionNode(version: string, log: Log): Promise<ProvisionResult> {
  return telemetrySpan("provision.node", { "node.version": version }, () => provisionNodeImpl(version, log));
}

async function provisionNodeImpl(version: string, log: Log): Promise<ProvisionResult> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`.node-version must pin an exact x.y.z (got "${version}") so a dist URL can be formed`);
  }
  const versionDir = runtimeVersionDir(version);
  const nodeBin = join(versionDir, "bin", "node");

  // Fast path: already installed — just make sure the symlink + node-path point here.
  if (existsSync(nodeBin)) {
    const changed = finalizeCurrent(versionDir, log);
    return { version, changed, nodePath: managedNodePath(), reason: changed ? "relinked" : "already current" };
  }

  const p = detectPlatform();
  const info = distInfo(version, p);
  mkdirSync(runtimeRoot(), { recursive: true });
  const tarball = join(runtimeRoot(), `.dl-${version}-${process.pid}.tar.gz`);
  const tmpDir = join(runtimeRoot(), `.tmp-${version}-${process.pid}`);
  const startedAt = Date.now();
  try {
    log("info", `provision: downloading Node ${version} (${p.os}-${p.arch}${p.libc === "musl" ? "-musl" : ""}) from ${info.base}`);
    await download(`${info.base}/${info.file}`, tarball);
    await verifyChecksum(tarball, info);
    await verifySignatureBestEffort(info, tarball, log);

    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    // Strip the top-level `node-vX-os-arch/` dir so bin/node lands directly under tmpDir.
    await run("tar", ["-xzf", tarball, "-C", tmpDir, "--strip-components=1"]);
    if (!existsSync(join(tmpDir, "bin", "node"))) throw new Error("extracted tarball has no bin/node");

    // Publish. If a concurrent provisioner (e.g. a manual `provision-node` racing the auto-updater)
    // already published this exact version, do NOT rmSync their live, possibly-`current`-symlinked
    // tree out from under them — discard our extract and just fix up the symlink. Otherwise move our
    // fully-extracted tree into place; if we lose the rename race (ENOTEMPTY/EEXIST), theirs wins.
    if (existsSync(nodeBin)) {
      rmSync(tmpDir, { recursive: true, force: true });
    } else {
      mkdirSync(dirname(versionDir), { recursive: true });
      try {
        renameSync(tmpDir, versionDir);
      } catch (e) {
        if (existsSync(nodeBin)) rmSync(tmpDir, { recursive: true, force: true });
        else throw e;
      }
    }
    // Verify the provisioned Node actually starts before pointing `current` at it. A bumped Node
    // that links a system lib the box lacks (libatomic on arm64 glibc, libgcc/libstdc++ on musl)
    // would otherwise wedge the daemon; throwing here keeps the existing runtime (the caller logs
    // the failure and carries on).
    try {
      await run(nodeBin, ["-v"]);
    } catch {
      throw new Error(`vendored Node ${version} was provisioned but cannot start — a required system library is missing (e.g. libatomic1 on arm64 glibc, libstdc++ on musl)`);
    }
    const changed = finalizeCurrent(versionDir, log);
    log("info", `provision: Node ${version} ready at ${versionDir}${changed ? " (current → this)" : ""}`);
    return { version, changed, nodePath: managedNodePath() };
  } catch (e) {
    log("warn", `provision: failed to provision Node ${version} — ${msg(e)}`);
    throw e;
  } finally {
    recordDependencyDuration(Date.now() - startedAt, { "dependency.name": "node-provision" });
    for (const f of [tarball]) {
      try {
        rmSync(f, { force: true });
      } catch {
        /* ignore */
      }
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Flip `current` to versionDir and (re)write the node-path file to the stable managed path. */
function finalizeCurrent(versionDir: string, log: Log): boolean {
  const changed = flipCurrent(versionDir);
  const file = nodePathFile();
  const stable = managedNodePath();
  try {
    mkdirSync(dirname(file), { recursive: true });
    if (!existsSync(file) || readFileSync(file, "utf8") !== stable) {
      const tmp = `${file}.${process.pid}`;
      writeFileSync(tmp, stable);
      renameSync(tmp, file);
    }
  } catch (e) {
    log("warn", `provision: could not update node-path file — ${msg(e)}`);
  }
  return changed;
}
