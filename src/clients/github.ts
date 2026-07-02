import { createHash } from "node:crypto";
import { runJson } from "./exec.ts";
import type { PrInfo, PrState, ReviewSig } from "../types.ts";

interface ThreadsResp {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: { nodes?: { isResolved: boolean; comments?: { nodes?: { id: string }[] } }[] };
      };
    };
  };
}
interface CheckRollup {
  statusCheckRollup?: { name?: string; context?: string; conclusion?: string; state?: string }[];
}

const FAILING = /FAIL|ERROR|TIMED_OUT|CANCELLED|FAILURE/;

/** Read-only GitHub queries via the `gh` CLI (uses the user's gh auth). */
export class GitHubClient {
  private readonly gh: string;
  constructor(gh: string = "gh") {
    this.gh = gh;
  }

  /** Discover a PR by its head branch. Used only for the FIRST sighting of a run's PR (before we've
   *  recorded its number) — `--head` stops matching once the head branch is deleted, so once a number
   *  is known callers poll `prByNumber` instead, which survives head-branch deletion on merge. */
  async prForBranch(repo: string, branch: string): Promise<PrInfo | null> {
    const arr = await runJson<{ number: number; state: string; url: string }[]>(
      this.gh,
      ["pr", "list", "--repo", repo, "--head", branch, "--state", "all", "--json", "number,state,url", "--limit", "1"],
      { allowFail: true },
    ).catch(() => [] as { number: number; state: string; url: string }[]);
    const first = arr[0];
    return first ? { number: first.number, state: first.state as PrState, url: first.url } : null;
  }

  /** Look up a PR by number — the durable identity once a run has adopted one. Unlike `--head`,
   *  this keeps resolving after the head branch is deleted (e.g. GitHub auto-delete-on-merge). */
  async prByNumber(repo: string, prNumber: number): Promise<PrInfo | null> {
    const pr = await runJson<{ number: number; state: string; url: string }>(
      this.gh,
      ["pr", "view", String(prNumber), "--repo", repo, "--json", "number,state,url"],
      { allowFail: true },
    ).catch(() => null);
    return pr && pr.number ? { number: pr.number, state: pr.state as PrState, url: pr.url } : null;
  }

  async reviewSignature(repo: string, prNumber: number): Promise<ReviewSig> {
    const slash = repo.indexOf("/");
    const owner = repo.slice(0, slash);
    const name = repo.slice(slash + 1);

    const query =
      "query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){reviewThreads(first:100){nodes{isResolved comments(last:1){nodes{id}}}}}}}";
    const threads = await runJson<ThreadsResp>(
      this.gh,
      ["api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `n=${prNumber}`],
      { allowFail: true },
    ).catch(() => ({}) as ThreadsResp);
    const unresolvedIds = (threads.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [])
      .filter((t) => t.isResolved === false)
      .map((t) => t.comments?.nodes?.[0]?.id ?? "x");

    const rollup = await runJson<CheckRollup>(
      this.gh,
      ["pr", "view", String(prNumber), "--repo", repo, "--json", "statusCheckRollup"],
      { allowFail: true },
    ).catch(() => ({}) as CheckRollup);
    const failing = (rollup.statusCheckRollup ?? [])
      .filter((c) => FAILING.test(c.conclusion ?? c.state ?? ""))
      .map((c) => c.name ?? c.context ?? "check");

    const sig = createHash("sha1").update(JSON.stringify({ t: unresolvedIds, c: failing })).digest("hex");
    return { unresolved: unresolvedIds.length, failing: failing.length, sig };
  }
}
