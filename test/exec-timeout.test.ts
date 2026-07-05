import { describe, it, expect } from "vitest";
import { ExecTimeoutError, run } from "../src/clients/exec.ts";
import { isTickStale } from "../src/server/client.ts";

describe("run() timeout", () => {
  it("returns normally within budget", async () => {
    const r = await run("echo", ["hi"], { timeoutMs: 5000 });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("hi");
  });

  it("kills a hung subprocess and throws ExecTimeoutError", async () => {
    await expect(run("sleep", ["10"], { timeoutMs: 200 })).rejects.toBeInstanceOf(ExecTimeoutError);
  });

  it("throws on timeout even under allowFail (a timeout is not exit-code data)", async () => {
    await expect(run("sleep", ["10"], { timeoutMs: 200, allowFail: true })).rejects.toBeInstanceOf(ExecTimeoutError);
  });

  it("still returns non-zero exits as data under allowFail", async () => {
    const r = await run("false", [], { timeoutMs: 5000, allowFail: true });
    expect(r.code).not.toBe(0);
  });
});

describe("isTickStale", () => {
  const interval = 60;
  it("fresh tick → not stale", () => {
    expect(isTickStale(1000, 900, interval, 1060)).toBe(false);
  });
  it("no tick yet on a young server → not stale (startedAt is the baseline)", () => {
    expect(isTickStale(null, 1000, interval, 1300)).toBe(false);
  });
  it("no tick long after startup → stale", () => {
    expect(isTickStale(null, 1000, interval, 1000 + 901)).toBe(true);
  });
  it("tick stopped touching → stale after max(10×interval, 900)", () => {
    expect(isTickStale(1000, 0, interval, 1000 + 899)).toBe(false);
    expect(isTickStale(1000, 0, interval, 1000 + 901)).toBe(true);
  });
  it("threshold scales with a long tick interval", () => {
    // 10 × 300s = 3000s > the 900s floor
    expect(isTickStale(1000, 0, 300, 1000 + 2000)).toBe(false);
    expect(isTickStale(1000, 0, 300, 1000 + 3001)).toBe(true);
  });
});
