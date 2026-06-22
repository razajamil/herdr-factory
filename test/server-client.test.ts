import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { serverInfoPath } from "../src/config.ts";
import { NoServerError, pingHealth, readServerInfo, serverFetch, viaServerOrLocal } from "../src/server-client.ts";

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hf-server-"));
  prev = process.env.HERDR_FACTORY_STATE_ROOT;
  process.env.HERDR_FACTORY_STATE_ROOT = dir;
});
afterEach(() => {
  if (prev === undefined) delete process.env.HERDR_FACTORY_STATE_ROOT;
  else process.env.HERDR_FACTORY_STATE_ROOT = prev;
  rmSync(dir, { recursive: true, force: true });
});

function writeServerInfo(port: number, version = "0.1.0"): void {
  writeFileSync(serverInfoPath(), JSON.stringify({ pid: process.pid, port, version, startedAt: 0 }));
}

/** Spin up a throwaway HTTP server that mirrors the routes the client cares about. */
async function startTestServer(handler: (path: string, method: string) => { status: number; body: unknown }): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const { status, body } = handler(req.url ?? "/", req.method ?? "GET");
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  return { server, port };
}

describe("readServerInfo", () => {
  it("returns null when server.json is absent", () => {
    expect(readServerInfo()).toBeNull();
  });

  it("returns null on malformed server.json", () => {
    writeFileSync(serverInfoPath(), "{ not json");
    expect(readServerInfo()).toBeNull();
  });

  it("parses a valid server.json", () => {
    writeServerInfo(8765, "1.2.3");
    expect(readServerInfo()).toEqual({ pid: process.pid, port: 8765, version: "1.2.3", startedAt: 0 });
  });
});

describe("pingHealth", () => {
  it("is false for a port nobody is listening on", async () => {
    // Port 1 is privileged/unused — connection refused.
    expect(await pingHealth(1, 500)).toBe(false);
  });

  it("is true when /health answers {ok:true}", async () => {
    const { server, port } = await startTestServer((path) => (path === "/health" ? { status: 200, body: { ok: true } } : { status: 404, body: {} }));
    try {
      expect(await pingHealth(port, 1000)).toBe(true);
    } finally {
      server.close();
    }
  });

  it("is false when /health is unhealthy", async () => {
    const { server, port } = await startTestServer(() => ({ status: 500, body: { ok: false } }));
    try {
      expect(await pingHealth(port, 1000)).toBe(false);
    } finally {
      server.close();
    }
  });
});

describe("viaServerOrLocal", () => {
  it("falls back to local() when there is no server", async () => {
    let localRan = false;
    const { viaServer, data } = await viaServerOrLocal({ method: "POST", path: "/repos/x/tick" }, async () => {
      localRan = true;
      return { ran: true };
    });
    expect(viaServer).toBe(false);
    expect(localRan).toBe(true);
    expect(data).toEqual({ ran: true });
  });

  it("falls back to local() when server.json points at a dead port", async () => {
    writeServerInfo(1); // connection refused
    const { viaServer, data } = await viaServerOrLocal({ method: "POST", path: "/repos/x/tick" }, async () => ({ ran: "local" }));
    expect(viaServer).toBe(false);
    expect(data).toEqual({ ran: "local" });
  });

  it("uses the server when one is reachable, and does NOT run local()", async () => {
    const { server, port } = await startTestServer(() => ({ status: 200, body: { ran: true, via: "server" } }));
    writeServerInfo(port);
    let localRan = false;
    try {
      const { viaServer, data } = await viaServerOrLocal({ method: "POST", path: "/repos/x/tick" }, async () => {
        localRan = true;
        return { ran: "local" };
      });
      expect(viaServer).toBe(true);
      expect(localRan).toBe(false);
      expect(data).toEqual({ ran: true, via: "server" });
    } finally {
      server.close();
    }
  });

  it("propagates an error from a reached server (does NOT fall back)", async () => {
    const { server, port } = await startTestServer(() => ({ status: 500, body: { error: "boom" } }));
    writeServerInfo(port);
    let localRan = false;
    try {
      await expect(
        viaServerOrLocal({ method: "POST", path: "/repos/x/tick" }, async () => {
          localRan = true;
          return {};
        }),
      ).rejects.toThrow("boom");
      expect(localRan).toBe(false);
    } finally {
      server.close();
    }
  });
});

describe("serverFetch", () => {
  it("throws NoServerError when no server.json exists", async () => {
    await expect(serverFetch("GET", "/health")).rejects.toBeInstanceOf(NoServerError);
  });
});
