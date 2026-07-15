import { describe, expect, it, vi } from "vitest";
import { createApp, type RepoRuntime, type ServerContext } from "../src/server/app.ts";

interface StatusBody {
  sources: { name: string; type: string; auth?: { state: string } }[];
  belts: { name: string; diagnostic?: { state: string } }[];
  evidenceSso?: { state: string };
  active: { worker: string | null }[];
}

describe("dashboard server payloads", () => {
  it("keeps quick status probe-free and identifies an eligible item's belt", async () => {
    const paneState = vi.fn(async () => "working");
    const authStatus = vi.fn(async () => ({ state: "ok" as const }));
    const health = vi.fn(async () => undefined);
    const listEligible = vi.fn(async () => [{ key: "HF-1", summary: "Fast dashboard", type: "Task" }]);
    const run = {
      id: 1,
      ticketKey: "HF-2",
      workSource: "jira",
      belt: "ship",
      phase: "running",
      step: "work",
      prNumber: null,
      summary: "Active item",
      outcome: null,
      paneId: "pane-1",
      endedAt: null,
    };
    const source = { name: "jira", type: "jira", client: { authStatus, health, listEligible } };
    const runtime = {
      ticking: false,
      deps: {
        config: {
          repoName: "demo",
          limits: { maxActiveWorkspaces: 2 },
          sources: [{ name: "jira", type: "jira" }],
          belts: [{ name: "ship", beltType: "work_to_pull_request", source: "jira", priority: 1, label: "pickup", steps: [{ name: "work" }] }],
        },
        belts: [{ name: "ship", source: "jira", label: "pickup" }],
        store: {
          activeRuns: () => [run],
          listRuns: () => [],
          runStepsFor: () => [],
          getSourceAuth: () => undefined,
          authStuckEvidenceUpload: () => false,
          undeliveredEvidenceUploadsForRun: () => [],
        },
        herdr: { paneState },
        resolveSource: () => source,
        now: () => 1,
        log: vi.fn(),
      },
    } as unknown as RepoRuntime;
    const context = {
      getRepo: (name: string) => (name === "demo" ? runtime : undefined),
    } as unknown as ServerContext;
    const app = createApp(context);

    const quickResponse = await app.request("/repos/demo/status?quick=1");
    expect(quickResponse.status).toBe(200);
    const quick = (await quickResponse.json()) as StatusBody;
    expect(quick.sources).toEqual([{ name: "jira", type: "jira" }]);
    expect(quick.belts).toEqual([expect.objectContaining({ name: "ship", steps: ["work"] })]);
    expect(quick.belts[0]?.diagnostic).toBeUndefined();
    expect(quick.evidenceSso).toBeUndefined();
    expect(quick.active).toEqual([expect.objectContaining({ worker: null })]);
    expect(authStatus).not.toHaveBeenCalled();
    expect(health).not.toHaveBeenCalled();
    expect(paneState).not.toHaveBeenCalled();

    const diagnosticsResponse = await app.request("/repos/demo/status?refresh=1");
    expect(diagnosticsResponse.status).toBe(200);
    const diagnostics = (await diagnosticsResponse.json()) as StatusBody;
    expect(diagnostics.sources).toEqual([{ name: "jira", type: "jira", auth: { state: "ok" } }]);
    expect(diagnostics.belts[0]?.diagnostic).toEqual({ state: "ok" });
    expect(diagnostics.evidenceSso).toEqual({ state: "na" });
    expect(diagnostics.active).toEqual([expect.objectContaining({ worker: "working" })]);
    expect(authStatus).toHaveBeenCalledOnce();
    expect(health).toHaveBeenCalledWith(["pickup"]);
    expect(paneState).toHaveBeenCalledOnce();

    const eligibleResponse = await app.request("/repos/demo/eligible");
    expect(eligibleResponse.status).toBe(200);
    expect(await eligibleResponse.json()).toEqual({
      eligible: [{ source: "jira", belt: "ship", key: "HF-1", summary: "Fast dashboard", type: "Task" }],
    });
  });
});
