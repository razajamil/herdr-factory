// Raw GitHub REST client for the github_issues work source. Deliberately NOT the gh CLI: this
// rides the tested Effect http pipeline (token buckets, Retry-After, typed status codes) — and
// typed statuses are load-bearing here: a transferred issue answers 301 (which a CLI or a
// redirect-following fetch would silently chase INTO THE NEW REPO, auth and method preserved) and
// a deleted issue answers 410. All issue API calls therefore use redirect: "manual".
// The gh CLI remains the transport for the PR watcher and for agents inside prompts; only its
// auth is borrowed here (`gh auth token`) when no GITHUB_TOKEN is configured.
import * as Effect from "effect/Effect";
import { runEffectPromise } from "../runtime/effect.ts";
import { recordRateLimitRemaining } from "../telemetry/index.ts";
import { run } from "./exec.ts";
import { GITHUB_MUTATION_BUCKETS, githubReadBucket } from "./github-budget.ts";
import { HttpStatusError, httpWithPolicy, type HttpError, type HttpPolicy, type HttpResponse, type TokenBucket } from "./http.ts";

const API = "https://api.github.com";
const API_VERSION = "2022-11-28";
const JSON_TIMEOUT_MS = 30_000;
const MEDIA_TIMEOUT_MS = 120_000;

/** GitHub's secondary rate limits answer 403 + Retry-After (not 429) — widen the retry predicate
 *  for THIS backend only. Everything else keeps the default transport/timeout/429/5xx set. */
function githubRetryable(e: HttpError): boolean {
  if (e instanceof HttpStatusError) {
    return e.status === 429 || e.status >= 500 || (e.status === 403 && e.retryAfterMs != null);
  }
  return true; // timeout / network
}

/** Why an issue is GONE (retrying cannot help), per documented status codes — or null for
 *  anything else. 301 = transferred to another repo; 410 = deleted (readable repo); 404 =
 *  deleted-or-inaccessible. The transition/ask paths map these to stale/StaleItemError. */
export function classifyGone(e: unknown): string | null {
  if (!(e instanceof HttpStatusError)) return null;
  if (e.status === 301) return "transferred to another repository";
  if (e.status === 410) return "deleted";
  if (e.status === 404) return "not found (deleted, or the token lost access)";
  return null;
}

// REST payload shapes (the fields we read; everything else rides along in `fields`).
export interface GhLabel {
  name: string;
}
export interface GhIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  state_reason?: string | null;
  labels?: (GhLabel | string)[];
  assignees?: { login: string }[];
  user?: { login: string } | null;
  body?: string | null;
  body_html?: string;
  pull_request?: unknown; // present ⇒ this "issue" is actually a PR
  html_url?: string;
  /** GitHub's native org-level issue type (GA 2025) — preferred over label mapping when present. */
  type?: { name?: string } | null;
  [key: string]: unknown;
}
export interface GhComment {
  id: number;
  created_at: string;
  body?: string | null;
  body_html?: string;
  user?: { login: string } | null;
  html_url?: string;
}

export function labelNames(issue: GhIssue): string[] {
  return (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean);
}

/** Test seam: the process-wide budget buckets, overridable per client instance. */
export interface GithubBudget {
  read: readonly TokenBucket[];
  mutation: readonly TokenBucket[];
}

export class GithubIssuesClient {
  private readonly repo: string; // owner/name
  private readonly envToken: string | undefined;
  private readonly tokenCmd: () => Promise<string | null>;
  private readonly budget: GithubBudget;
  private token: string | null | undefined; // memoized (undefined = not yet fetched)

  constructor(repo: string, envToken?: string, tokenCmd?: () => Promise<string | null>, budget?: GithubBudget) {
    this.repo = repo;
    this.envToken = envToken?.trim() || undefined;
    this.budget = budget ?? { read: [githubReadBucket], mutation: GITHUB_MUTATION_BUCKETS };
    // Default bootstrap: the user's gh CLI session. Injectable for tests.
    this.tokenCmd =
      tokenCmd ??
      (async () => {
        const r = await run("gh", ["auth", "token"], { allowFail: true });
        return r.code === 0 ? r.stdout.trim() || null : null;
      });
  }

  private async authToken(): Promise<string> {
    if (this.envToken) return this.envToken;
    if (this.token === undefined) this.token = await this.tokenCmd();
    if (!this.token) {
      throw new Error("GitHub auth missing — set GITHUB_TOKEN in the repo env, or authenticate the gh CLI (`gh auth login`)");
    }
    return this.token;
  }

  /** One API round-trip: auth → manual-redirect fetch through the budget buckets → JSON. A 401
   *  invalidates the memoized gh-CLI token and retries ONCE (token rotation); the env token is
   *  authoritative and never refreshed. Non-2xx (incl. 301/410 — see classifyGone) throw
   *  HttpStatusError. */
  private async request(method: string, path: string, opts: { body?: unknown; accept?: string; mutation?: boolean } = {}): Promise<HttpResponse> {
    const attempt = async (): Promise<HttpResponse> => {
      const policy: HttpPolicy = {
        buckets: opts.mutation ? this.budget.mutation : this.budget.read,
        isRetryable: githubRetryable,
        // Mutations fail fast back to their durable retry loop (the transition outbox) instead of
        // stalling a reconcile tick on a long secondary-limit sleep; POSTs also retry only once
        // (a timed-out write may have landed — comment duplication over retry storms).
        ...(opts.mutation ? { retries: 1, maxRetryAfterMs: 15_000 } : {}),
      };
      const res = await runEffectPromise(
        httpWithPolicy(
          {
            url: `${API}${path}`,
            method,
            redirect: "manual",
            timeoutMs: JSON_TIMEOUT_MS,
            headers: {
              Authorization: `Bearer ${await this.authToken()}`,
              Accept: opts.accept ?? "application/vnd.github+json",
              "X-GitHub-Api-Version": API_VERSION,
              ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          },
          policy,
        ),
      );
      const remaining = Number(res.headers.get("x-ratelimit-remaining"));
      if (Number.isFinite(remaining)) recordRateLimitRemaining(remaining, { backend: "github", resource: res.headers.get("x-ratelimit-resource") ?? "core" });
      return res;
    };
    try {
      return await attempt();
    } catch (e) {
      if (e instanceof HttpStatusError && e.status === 401 && !this.envToken && this.token !== undefined) {
        this.token = undefined; // gh CLI token rotated — refetch once
        return attempt();
      }
      throw e;
    }
  }

  private async json<T>(method: string, path: string, opts: { body?: unknown; accept?: string; mutation?: boolean } = {}): Promise<T> {
    const res = await this.request(method, path, opts);
    return (res.text ? JSON.parse(res.text) : {}) as T;
  }

  /** Open issues carrying `label`, oldest first, one page of 100. The list endpoint interleaves
   *  PRs (they carry a `pull_request` key) — the CALLER filters, so the contamination rule stays
   *  visible at the eligibility policy layer. */
  async listOpenIssuesByLabel(label: string, page: number): Promise<GhIssue[]> {
    const q = `labels=${encodeURIComponent(label)}&state=open&sort=created&direction=asc&per_page=100&page=${page}`;
    return this.json<GhIssue[]>("GET", `/repos/${this.repo}/issues?${q}`);
  }

  /** `full: true` asks for application/vnd.github.full+json, whose body_html carries the
   *  JWT-signed attachment URLs that actually resolve on private repos (raw-body
   *  /user-attachments URLs 404 under PATs). */
  async getIssue(n: number, opts: { full?: boolean } = {}): Promise<GhIssue> {
    return this.json<GhIssue>("GET", `/repos/${this.repo}/issues/${n}`, {
      accept: opts.full ? "application/vnd.github.full+json" : undefined,
    });
  }

  /** All comments on an issue (paginated), optionally only those updated since `since` — note
   *  `since` filters on updated_at, so callers must still guard on created_at (the
   *  edited-old-comment trap). */
  async listComments(n: number, opts: { since?: string; full?: boolean } = {}): Promise<GhComment[]> {
    const out: GhComment[] = [];
    for (let page = 1; page <= 10; page++) {
      const q = [`per_page=100`, `page=${page}`, opts.since ? `since=${encodeURIComponent(opts.since)}` : ""].filter(Boolean).join("&");
      const batch = await this.json<GhComment[]>("GET", `/repos/${this.repo}/issues/${n}/comments?${q}`, {
        accept: opts.full ? "application/vnd.github.full+json" : undefined,
      });
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  async createComment(n: number, body: string): Promise<GhComment> {
    return this.json<GhComment>("POST", `/repos/${this.repo}/issues/${n}/comments`, { body: { body }, mutation: true });
  }

  async addLabels(n: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    await this.json("POST", `/repos/${this.repo}/issues/${n}/labels`, { body: { labels }, mutation: true });
  }

  /** Remove a label from an issue; false = it wasn't there (documented 404 — benign, idempotent). */
  async removeLabel(n: number, label: string): Promise<boolean> {
    try {
      await this.request("DELETE", `/repos/${this.repo}/issues/${n}/labels/${encodeURIComponent(label)}`, { mutation: true });
      return true;
    } catch (e) {
      if (e instanceof HttpStatusError && e.status === 404) return false;
      throw e;
    }
  }

  async closeIssue(n: number, reason: "completed" | "not_planned"): Promise<void> {
    await this.json("PATCH", `/repos/${this.repo}/issues/${n}`, { body: { state: "closed", state_reason: reason }, mutation: true });
  }

  /** Does the repo define this label? (GET /labels/{name} → 404 = no.) */
  async labelExists(name: string): Promise<boolean> {
    try {
      await this.request("GET", `/repos/${this.repo}/labels/${encodeURIComponent(name)}`);
      return true;
    } catch (e) {
      if (e instanceof HttpStatusError && e.status === 404) return false;
      throw e;
    }
  }

  /** Create a repo label, tolerating 422 = already exists (a concurrent creator won the race). */
  async createLabel(name: string, color: string, description: string): Promise<void> {
    try {
      await this.json("POST", `/repos/${this.repo}/labels`, { body: { name, color, description }, mutation: true });
    } catch (e) {
      if (e instanceof HttpStatusError && e.status === 422) return;
      throw e;
    }
  }

  async getRepo(): Promise<{ has_issues?: boolean; permissions?: { push?: boolean } }> {
    return this.json("GET", `/repos/${this.repo}`);
  }

  /** Download an attachment/image (redirect-FOLLOWING — media URLs legitimately redirect to
   *  storage backends; unlike API calls there is no cross-repo mutation hazard on a GET for
   *  bytes). Authorization is deliberately NOT attached: these are JWT-signed/camo URLs where the
   *  signature IS the auth, and leaking the API token to arbitrary redirect targets would be
   *  worse than a failed download. */
  async downloadBytes(url: string): Promise<Buffer> {
    const res = await runEffectPromise(
      httpWithPolicy(
        { url, timeoutMs: MEDIA_TIMEOUT_MS, redirect: "follow" },
        { buckets: this.budget.read, isRetryable: githubRetryable },
        "bytes",
      ),
    );
    return res.bytes!;
  }
}
