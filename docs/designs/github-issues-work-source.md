# Design: GitHub Issues work source + WorkSource contract v2

**Status: PROPOSAL — awaiting decisions on §7 before implementation.**

Adds `github_issues` as a third work source (poll issues by trigger label, drive them to a merged
PR / terminal state) and hardens the `WorkSource` contract into a fixed, documented, test-enforced
API so future sources (Linear, GitLab, …) plug in without touching core. All changes are clean
breaks (pre-1.0, no compat shims), landed as one PR-train of five stages (§5).

Provenance: produced from a parallel audit of every source-facing subsystem, external research on
the GitHub REST API / prior art (OpenHands resolver, Copilot coding agent) / Linear portability,
three independent designs merged by a judge, then four adversarial verification passes. Verifier
corrections are integrated throughout; the load-bearing ones were re-verified against source by
hand (`instrumentObject` async-wrapping at telemetry/index.ts:205-215, hardcoded
`redirect:"follow"` at http.ts:86, lock-free outbox delivery at reconcile.ts:78-96, the sync
render path at step.ts:210).

---

## 1. Why the contract must change (and how little)

The existing abstraction is genuinely narrow — every `WorkSource` method has one or two call
sites: `transition` only via the outbox (reconcile.ts:34), `materialize` only in step.ts:118, the
human loop at reconcile.ts:604/865, `describe` at reconcile.ts:1246, `health` at doctor.ts:118,
`listEligible` at reconcile.ts:302 + CLI/server list paths. What leaks is everything *around* it:

| Leak | Where |
|---|---|
| Work-doc prompt tokens switch on `src.type === "jira"` | step.ts:245-253 — a third type silently inherits the local_markdown layout |
| `transition(): boolean` can't say "this item is gone" | outbox retries a thrown 404/410 forever at the 1h cap (store.ts:576-593) |
| `SourceType` + `MatchItem` closed unions | types.ts:236, :353 — central edits per new source |
| 8 hand-maintained switch sites per source type | types.ts, config.ts:84-88 + :618-635, build-deps.ts:60-73, step.ts:245, doctor.ts:123-129, tui/config-fields.ts:101-133, tui/config-editor.ts:97-104 |
| `Secrets` is Jira-shaped (email + token) | config.ts:279-282 — Linear needs a bare token; GitHub optionally takes one |
| Contract invariants live in prose doc-comments | deps.ts:66-94 — nothing enforces them on source N+1 |
| Unmarked `postNote` can poison the human-reply loop | jira-source.ts:133-135 vs the marker filter at :154 |

### Contract deltas (summary)

| # | Change | Justification |
|---|--------|---------------|
| 1 | `workDoc(memDirAbs): Promise<WorkDocInfo>` — new 9th method | deletes the step.ts:245-253 type-switch. **Async** because `instrumentObject` wraps every method into an async telemetry span (telemetry/index.ts:205-215) — a sync method through the proxy returns a Promise and `@@WORK_DOC@@` would render `.memory/undefined`. `renderStepPrompt` goes async (`telemetrySpanSync` → `telemetrySpan`), awaited in `spawnStep` |
| 2 | `transition` returns `TransitionResult` (`applied \| noop \| stale`) | closes the retry-forever hole for deleted/transferred items; the Linear/ADO rejected-vs-unmapped portability shape |
| 3 | `readonly spec: WorkSourceSpec` — declarative; consumed by doctor + contract tests ONLY | makes status-of-record ownership and mapped states machine-visible without engine branching |
| 4 | Invariants promoted to a numbered charter (INV-1..11), enforced by `test/work-source-contract.test.ts` | compile-forcing moves from the closed union to a shared behavioral suite |
| 5 | `MatchItem` closed union → generic base + per-source convenience interfaces + type guards | nothing in core switches on the union (only user `match.ts`, reconcile.ts:335; `ticketOf`; `item.key` dedup) — source N+1 needs zero central type edits |
| 6 | Source registry (`SourceDescriptor` per type) collapsing the 8 switch sites | one edit point per new source |
| 7 | `Secrets` → env map + per-descriptor secrets manifest (on-disk file format unchanged) | generic credentials without a user-visible break |
| 8 | Engine: two-phase stale handling; pollHumanReply throw → poll-miss backoff with a stale escape; Jira marker filter widened; `describe` key-echo recheck in `claimTicket` | §4 |

---

## 2. The WorkSource contract v2

### 2.1 Supporting types

```ts
/** How the materialized work doc is described to agent prompts. `path` is RELATIVE to the run's
 *  memDir ("ticket.json", "task.md", "task/"); step.ts renders @@WORK_DOC@@ = `${MEMORY_DIR}/${path}`
 *  and @@WORK_DOC_KIND@@ = kind. */
export interface WorkDocInfo {
  path: string;
  kind: string; // e.g. "Jira ticket (JSON)", "GitHub issue (markdown: body + comments)"
}

/** Outcome of one transition delivery attempt. Replaces the old boolean. */
export type TransitionResultKind =
  /** Backend state actually moved. Outbox: mark delivered + record a `transition` event. */
  | "applied"
  /** Nothing to do: already at the target, OR the state is UNMAPPED for this source
   *  (spec.mappedStates). Unmapped MUST be decided with ZERO network (teardown stays silent for
   *  sources whose terminal state is automation-owned — the Jira precedent, jira-source.ts:96-99).
   *  MUST also be the answer when a write races the backend's own automation (GitHub's
   *  Fixes-#n auto-close beat us to `merged`). Outbox: delivered, silent. */
  | "noop"
  /** The item is no longer ours: transferred (GitHub: 301), deleted (410), inaccessible (404),
   *  or preconditions destroyed. Retrying cannot help — the outbox marks it DELIVERED and flags
   *  the run for the run-locked stale policy (§4.1), which aborts an active run promptly,
   *  bounding further token spend. NEVER return stale for a plausibly-transient failure — throw
   *  instead (throw = retry me). */
  | "stale";

export interface TransitionResult {
  kind: TransitionResultKind;
  detail?: string; // human-readable context; becomes the attention-note body for "stale"
}

/** Typed escape for the human-question loop: the item backing a question is gone (deleted /
 *  transferred / inaccessible). askHuman/pollHumanReply throw this instead of a generic error;
 *  the engine escalates attention instead of backing off forever (§4.2). */
export class StaleItemError extends Error {}

/** Declarative ownership/capability record. Consumed by doctor, the TUI, and the shared contract
 *  test suite ONLY — the reconciler never branches on it, so it cannot drift into a second state
 *  machine. Constant for the instance's lifetime. */
export interface WorkSourceSpec {
  /** "external": the backend owns lifecycle (Jira statuses, GitHub labels/open-closed) and the
   *  source MUST NEVER touch the work_items table (db/migrate.ts:84-87).
   *  "internal": herdr-factory's work_items table owns it (local_markdown). */
  statusOfRecord: "external" | "internal";
  /** The WorkStates transition() actually writes. Everything else must be a network-free noop —
   *  the contract suite asserts it. */
  mappedStates: readonly WorkState[];
  /** How human replies arrive — scopes the contract suite's marker tests (comment-stream sources
   *  must filter their own artifacts; file-channel sources read a dedicated answer section). */
  replyChannel: "comments" | "file";
  /** Note when terminal convergence is (partly) owned by backend automation — display only. */
  terminalAutomation?: string;
}
```

### 2.2 The charter (INV-1..11) — enforced by `test/work-source-contract.test.ts`

- **INV-1 RE-CLAIM CONVERGENCE.** Whatever `listEligible` filters on MUST be moved by a delivered
  `transition(in_development | terminal)`. The engine's only other guards — an active run for
  (source, key) (reconcile.ts:324) and a pending write-back (reconcile.ts:328) — eventually clear,
  after which a still-listed item is claimed again and the work re-done.
- **INV-2 IDEMPOTENT, RETRY-SAFE transition.** The outbox re-calls it after partial failures,
  strictly in-order per run (store.ts:555-562). applied/noop/stale = delivered; throw = retry with
  60s→1h backoff, never abandoned (store.ts:576-593).
- **INV-3 UNMAPPED STATES COST ZERO NETWORK.** Reads to establish "already converged" for a
  MAPPED state are allowed.
- **INV-4 materialize IS IDEMPOTENT** (no-op once the primary doc exists) **and BEST-EFFORT**
  (log, never throw) — it re-runs on EVERY claiming tick (step.ts:103-124). Sanitize untrusted
  text for prompt use (strip HTML comments + invisible characters; keep the raw payload in a
  sidecar). Never promise complete media capture.
- **INV-5 askHuman RETURNS A DURABLE externalId** (+ createdAt when available); it is re-invoked
  every tick until an externalId is persisted (reconcile.ts:843-857), so it SHOULD be idempotent
  per questionId (search for the question marker before posting). Throw `StaleItemError` when the
  item is gone.
- **INV-6 SELF-AUTHORSHIP.** Every artifact the source writes to the reply channel (questions,
  notes) MUST carry the visible marker prefix `[herdr-factory` — and `pollHumanReply` MUST skip
  marker-bearing artifacts. Two hard rules learned the adversarial way:
  - *Author-identity filtering is NEVER load-bearing*: with shared credentials (gh CLI
    bootstrap, github.ts:20-26) the bot login IS the operator's login, and author filtering
    silently swallows the operator's genuine replies.
  - *Marker matching must ignore quoted context*: GitHub's one-click "Quote reply" prepends the
    question — marker included — as `> `-blockquote lines into a genuine human reply. Strip
    blockquote lines before scanning; a comment whose marker appears only inside quotes IS a
    reply. (Jira's filter at jira-source.ts:154 is widened from `[herdr-factory question:` to the
    generic `[herdr-factory` prefix with the same blockquote rule — closing the unmarked-postNote
    poisoning hazard for real, not just cosmetically.)
- **INV-7 KEYS ARE OPAQUE, STABLE, UNIQUE within the source, and SAFE** as a single unquoted
  shell token (step.ts:229), a git ref segment (branch.ts:32 — the sanitizer does NOT strip
  `#`/`/`), and a URL path segment (evidence S3 key, config.ts:73). Sources enforce this at
  `listEligible` (skip + warn on unsafe keys — local_markdown gains this guard for exotic
  filenames, like its existing `__` prefix rule). Prefer the backend's immutable id over mutable
  display identifiers (Linear's "ENG-123" mutates on team move). `summary` and `type` non-empty.
- **INV-8 BRING YOUR OWN rate limiting + hard timeouts** (token bucket, Retry-After). The engine
  only shapes volume (once-per-tick listEligible, claim admission reconcile.ts:290-293,
  poll/outbox backoffs). A hung call wedges the whole reconcile tick.
- **INV-9 THE CONFIGURED NAME IS THE DURABLE FK** on runs/intents/questions (types.ts:76,169,187).
  Renames strand in-flight runs — treat names as append-only. The default jira source keeps the
  name "jira" (migrate.ts:78-90).
- **INV-10 SINGLE FACTORY PER SOURCE BACKEND.** Claiming is arbitrated by the local store under
  the tick lock; source-side markers are PROJECTIONS of the claim, not locks (no surveyed backend
  except ADO offers CAS). Two factories with separate DBs on one backend can double-claim — a
  documented deployment constraint.
- **INV-11 describe MAY ACCEPT ALTERNATE IDENTIFIERS but MUST return the canonical key.** The
  engine re-checks active-run dedup against the RETURNED key before claiming (§4.4) — otherwise a
  source that normalizes identifiers (Linear "ENG-123" → UUID) double-claims via the manual path.

### 2.3 The interface

```ts
export interface WorkSource {
  /** Declarative capabilities/ownership. Cheap, constant, side-effect free. */
  readonly spec: WorkSourceSpec;

  /** A BOUNDED batch of eligible (todo) items in claim order — need not be exhaustive (claims
   *  are admission-capped per tick anyway). [] on empty. MAY throw on hard backend failure:
   *  every caller try/catches per source and degrades to [] (reconcile.ts:300-307). MUST exclude
   *  items the factory already moved (INV-1), items that are not claimable work (e.g. PRs in
   *  GitHub's issues listing), and items whose keys violate INV-7 (skip + warn). */
  listEligible(): Promise<MatchItem[]>;

  /** Metadata for one item by key — the manual `claim` path (reconcile.ts:1246). THROWS for
   *  unknown keys, including "exists but is not claimable work" (a PR number). INV-11. */
  describe(key: string): Promise<Ticket>;

  /** Move an item to a canonical lifecycle state. See TransitionResult + INV-1..3. Never reverse
   *  the backend's own automation (never reopen a closed issue). */
  transition(key: string, to: WorkState): Promise<TransitionResult>;

  /** Write the item's work doc (+ media) into memDir for the fix agent. INV-4. */
  materialize(key: string, memDir: string, log: Logger): Promise<void>;

  /** Describe what materialize wrote (drives @@WORK_DOC@@/@@WORK_DOC_KIND@@). Local-fs-only (may
   *  stat memDirAbs to disambiguate layouts, e.g. task/ vs task.md), never throws, NO network;
   *  must return a sensible default before materialize has run. Async ONLY because every client
   *  is wrapped by instrumentObject's async telemetry proxy (telemetry/index.ts:205-215).
   *  Replaces the core type-switch (step.ts:245-253). */
  workDoc(memDirAbs: string): Promise<WorkDocInfo>;

  /** Operator-facing informational note. Best-effort, no reply expected — and MARKER-TAGGED like
   *  every authored artifact (INV-6). */
  postNote(key: string, note: string): Promise<void>;

  /** Post a question for a human. INV-5. MAY throw — posting is retried every tick until an
   *  externalId is stored; StaleItemError when the item is gone. */
  askHuman(input: HumanAskInput): Promise<HumanAskResult>;

  /** Poll for a human reply. null = none yet (drives the 60s→5min poll backoff,
   *  store.ts:671-681). Anchor on externalId with externalCreatedAt as the deleted-anchor
   *  fallback; assume only append + created-after scan — never thread structure. Drop
   *  marker-bearing artifacts per INV-6 (blockquote-aware) and anything created at/before the
   *  question (also guards the edited-old-comment trap — hence "reply in a NEW comment").
   *  Throws are tolerated (counted as a poll miss + backoff, §4.2); StaleItemError escalates. */
  pollHumanReply(input: HumanPollInput): Promise<HumanReply | null>;

  /** Deep health probe: throw with an ACTIONABLE message (bad auth vs missing repo vs missing
   *  trigger label). This IS doctor --deep's per-source check (doctor.ts:118). */
  health(): Promise<void>;
}
```

### 2.4 MatchItem v2 — generic base, no central union

```ts
/** Lean identity for claim + branch naming. `displayKey` is the pretty, possibly-mutable form
 *  ("#123", "ENG-123") for logs/notes ONLY — never persisted, never fed to branches or dedup. */
export interface Ticket {
  key: string;
  summary: string;
  type: string;
  displayKey?: string; // defaults to key
  url?: string;        // browser link for operator notes/logs
}

/** GENERIC BASE — no central union. Core never switches on sourceType (only user match.ts
 *  predicates); per-source interfaces below are typing conveniences. Source N+1: ZERO edits here. */
export interface MatchItem extends Ticket {
  sourceType: SourceType;
  /** Backend labels/tags; [] when the concept doesn't exist — uniform so belt predicates can
   *  route on labels without knowing the source type. */
  labels: string[];
  /** Raw source-native payload (Jira issue.fields, REST issue object, front-matter…). */
  fields: Record<string, unknown>;
}

export interface JiraMatchItem extends MatchItem {
  sourceType: "jira";
  status: string;
}
export interface LocalMarkdownMatchItem extends MatchItem {
  sourceType: "local_markdown";
  // labels = front-matter `labels` array (else []); fields = the front-matter object
  path: string; filename: string; frontMatter: Record<string, unknown>; body: string;
}
export interface GithubIssuesMatchItem extends MatchItem {
  sourceType: "github_issues";
  number: number;            // === Number(key)
  repo: string;              // "owner/name" the issue lives in (may differ from the PR repo)
  state: "open";             // listEligible only surfaces open issues
  assignees: string[];
  author: string | null;
  body: string;              // raw markdown body, for match predicates
}
export const isJiraItem = (i: MatchItem): i is JiraMatchItem => i.sourceType === "jira";
export const isLocalMarkdownItem = (i: MatchItem): i is LocalMarkdownMatchItem => i.sourceType === "local_markdown";
export const isGithubIssuesItem = (i: MatchItem): i is GithubIssuesMatchItem => i.sourceType === "github_issues";

/** Union-free — MatchItem IS a Ticket. */
export function ticketOf(item: MatchItem): Ticket {
  return { key: item.key, summary: item.summary, type: item.type, displayKey: item.displayKey, url: item.url };
}
```

Breaks for users: `match.ts` files that imported the union re-type against the base or the
per-source interfaces; runtime `item.sourceType === "jira"` comparisons keep working. Existing
sources need small `listEligible` updates (compile-forced): local_markdown gains `labels`/`fields`;
Jira already conforms.

### 2.5 Source registry — the single edit point

```ts
// src/sources/registry.ts
/** SourceType stays a CLOSED union, derived from one const tuple — zod discrimination and TUI
 *  exhaustiveness keep working, with exactly one edit point. */
export const SOURCE_TYPES = ["jira", "local_markdown", "github_issues"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export interface SecretSpec {
  envKey: string;    // key in the per-repo env file ("JIRA_API_TOKEN", "GITHUB_TOKEN")
  required: boolean; // doctor fails when required and absent
  masked?: boolean;
  hint: string;      // doctor's remediation message
}

export interface SourceBuildCtx<TCfg> {
  repoName: string;
  sourceName: string;                    // resolved name ?? type — the durable FK (INV-9)
  cfg: TCfg;                             // this source's resolved camelCase block
  env: Readonly<Record<string, string>>; // the per-repo env file (replaces Secrets)
  store: Store;                          // internal ledgers / future orphan audits
  ghRepo: string;                        // resolved PR repo "owner/name" or "" (build-deps.ts:58)
  log: Logger;
}

export interface SourceDescriptor<TCfg = unknown> {
  readonly type: SourceType;
  /** The FULL .strict() source object: { type: literal, name?, <type>: block }. Joined into the
   *  config discriminated union; flows into config.schema.json via `npm run schema`. */
  readonly configSchema: ZodType;
  /** snake_case parse output → resolved camelCase block (was the if/else, config.ts:618-635). */
  resolveConfig(parsed: Record<string, unknown>): TCfg;
  /** Construct the live client (wrapped in instrumentObject by build-deps, build-deps.ts:65). */
  create(ctx: SourceBuildCtx<TCfg>): WorkSource;
  readonly secrets: readonly SecretSpec[];
  readonly tui: { defaultBlock(): Record<string, unknown>; fields: readonly TuiFieldSpec[] };
}

// jira MUST stay first with default name "jira" (migrate.ts:78-90 backfill invariant).
export const SOURCE_DESCRIPTORS: readonly SourceDescriptor[] = [
  jiraDescriptor, localMarkdownDescriptor, githubIssuesDescriptor,
];
```

**Source N+1 (Linear) checklist**, documented in registry.ts's header: `src/sources/linear/`
(descriptor + client + WorkSource impl), one line in `SOURCE_TYPES` + `SOURCE_DESCRIPTORS`,
`npm run schema`, optional `prompts/linear/`, contract-suite registration, optional MatchItem
convenience export. Zero other core edits.

### 2.6 Existing-source adaptations (same commit, compile-forced)

**JiraSource**: `spec = { statusOfRecord: "external", mappedStates: [todo, in_development,
in_review], replyChannel: "comments", terminalAutomation: "Jira's GitHub integration owns terminal
closure" }`; `workDoc()` → `{path: "ticket.json", kind: "Jira ticket (JSON)"}`; transition returns
applied/noop (behavior identical to jira-source.ts:96-99, stale never returned in v1);
**postNote gains the `[herdr-factory]` prefix AND pollHumanReply's skip predicate widens** from
`[herdr-factory question:` to blockquote-aware `[herdr-factory` (both halves required — the prefix
alone does NOT close the reply-poisoning hazard).

**LocalMarkdownSource**: `spec = { statusOfRecord: "internal", mappedStates: [all six],
replyChannel: "file" }`; `workDoc(memDirAbs)` with the `task/`-vs-`task.md` fs sniff moved
verbatim from step.ts:249-252 (token output stays byte-identical); transition wraps
`setWorkItemStatus` as applied/noop; `listEligible` gains `labels` (front-matter array else []),
`fields` (= frontMatter), and the INV-7 unsafe-key skip+warn guard.

---

## 3. The GitHub Issues source

**Type literal: `github_issues`** (not `github`) — avoids collision with the `repo.github` config
key (config.ts:195) and the `GitHubApi` PR-watch seam, and leaves room for future github_* sources.

### 3.1 Config

```yaml
work_sources:
  - type: github_issues
    name: gh-issues                    # optional; defaults "github_issues" (durable FK, INV-9)
    github_issues:
      repo: acme/tracker               # optional owner/name; default = resolved ghRepo (PR repo).
                                       # buildDeps THROWS at construction if both resolve empty
      trigger_label: herdr             # opt-in queue label; REMOVED at claim (§7 DP-12)
      state_labels:                    # created lazily in the repo on first use
        in_development: "herdr:in-development"
        in_review: "herdr:in-review"
        aborted: "herdr:aborted"       # informational failure artifact; issue stays OPEN
      close_on:                        # terminal backstop over Fixes-#n auto-close
        merged: true
        done: true
        aborted: false                 # true → close as not_planned
      type_labels:                     # issue label -> Ticket.type; first match wins (see DP-11)
        bug: Bug
        defect: Bug
        chore: Chore
        task: Chore
        enhancement: Feature
      default_type: Feature
      max_pages: 1                     # listEligible pages of 100, oldest-first (1-10)

belts:
  - name: gh-w2pr
    belt_type: work_to_pull_request
    source: gh-issues
```

Zod block (matches the repo's v4 `.prefault({})`/`.strict()` conventions):

```ts
const GithubIssuesBlockSchema = z.object({
  repo: z.string().trim().regex(/^[\w.-]+\/[\w.-]+$/, "owner/name").optional(),
  trigger_label: z.string().trim().min(1).default("herdr"),
  state_labels: z.object({
    in_development: z.string().trim().min(1).default("herdr:in-development"),
    in_review: z.string().trim().min(1).default("herdr:in-review"),
    aborted: z.string().trim().min(1).default("herdr:aborted"),
  }).prefault({}),
  close_on: z.object({
    merged: z.boolean().default(true),
    done: z.boolean().default(true),
    aborted: z.boolean().default(false),
  }).prefault({}),
  type_labels: z.record(z.string(), z.string().trim().min(1))
    .default({ bug: "Bug", defect: "Bug", chore: "Chore", task: "Chore", enhancement: "Feature" }),
  default_type: z.string().trim().min(1).default("Feature"),
  max_pages: z.number().int().min(1).max(10).default(1),
}).strict();
```

Secrets manifest: `[{ envKey: "GITHUB_TOKEN", required: false, masked: true, hint: "optional —
falls back to `gh auth token`" }]`.

### 3.2 Transport, auth, rate limits

- **New `src/clients/github-issues.ts`** — raw REST (`api.github.com`,
  `X-GitHub-Api-Version: 2022-11-28`) via the existing `httpWithPolicy` pipeline (http.ts:202-223),
  NOT the gh CLI: reuses the tested throttle/Retry-After machinery, typed status codes, and the
  Jira fetch-stub test harness (jira-source.test.ts:22-31). The gh CLI remains for agents inside
  prompts and for the PR watcher.
- **Auth**: `ctx.env.GITHUB_TOKEN` if set, else lazily `gh auth token` via execFile (memoized;
  injectable for tests). 401 invalidates the memo and refetches once (token rotation).
- **Redirects — load-bearing correction.** `HttpRequest` gains `redirect?: "follow" | "manual"`
  (default "follow", so Jira + attachment downloads stay byte-identical; http.ts:86 currently
  hardcodes follow). All issue API calls use `redirect: "manual"`:
  - **301 = the issue was transferred** — with transparent following, the same-origin redirect
    preserves the Authorization header AND the method (PATCH/POST/DELETE), so writes would
    silently mutate the issue in its NEW repo. Manual → `stale("transferred")`.
  - **410 = deleted** (readable repo) → `stale("deleted")`. **404 = inaccessible** (or deleted
    without read access) → `stale("inaccessible")`. GitHub does NOT answer a deleted issue with
    404 when you can read the repo — mapping only 404 would throw and retry forever.
- **`src/clients/github-budget.ts` — process-wide module singleton** (all repo runtimes spend one
  user's budget): read `TokenBucket(5, 10)`; mutations chained through TWO buckets —
  `TokenBucket(1, 2)` (80/min secondary cap headroom) AND an hourly bucket (~500/3600 ≈ 0.14/s,
  burst 10) for GitHub's documented **500 content-generating requests/hr** cap, which a
  per-minute bucket alone would exceed 7× if saturated. REST issue traffic rides the 5,000 req/hr
  REST budget, disjoint from the PR watcher's 5,000 GraphQL pts/hr — primaries never contend.
- **`HttpPolicy` gains `isRetryable?: (e: HttpError) => boolean`**; the GitHub predicate adds
  `403 && retryAfterMs != null` (secondary-limit shape) to the default 429/5xx. **Bounded**: cap
  inline 403-secondary sleeps well below the generic 60s and fail fast to the outbox (which
  already has backoff) — a mutation-heavy tick must not stall the reconciler for minutes. The
  client also derives a synthetic retry-after from `x-ratelimit-reset` when
  `x-ratelimit-remaining: 0`.
- Timeouts: 30s JSON / 120s media (jira.ts:8-9 parity — INV-8).
- Optional hardening: the gh-CLI PR watcher acquires the read bucket via sync `tryTake` before
  each exec. Full PR-client migration is out of scope.

### 3.3 Status of record & state mapping

**GitHub is the external status of record** — `spec = { statusOfRecord: "external", mappedStates:
[in_development, in_review, merged, done, aborted], replyChannel: "comments",
terminalAutomation: "GitHub auto-closes via PR closing keywords; source close is the idempotent
backstop" }`. work_items is never touched.

Eligibility = `open` + `trigger_label` + no `pull_request` key + not carrying an in-flight state
label (belt-and-braces against partial deliveries and hand-edited labels; `herdr:aborted`
deliberately does NOT gate eligibility so retry is a single human action).

Every mapped transition is an idempotent **GET issue → compute diff → apply** (INV-2). GET shows
nothing to change → `noop`; 301 → `stale("transferred")`; 410 → `stale("deleted")`; 404 →
`stale("inaccessible")`.

| WorkState | GitHub effect | Edge handling |
|---|---|---|
| todo | *(never requested by the engine)* | unmapped ⇒ noop, zero network (INV-3) |
| in_development | ensure labels exist; **add** `herdr:in-development` + strip other state labels, **then remove** `trigger_label` (this order keeps the belt-and-braces filter covering the partial-failure gap) | issue closed / 301 / 410 / 404 → stale (engine aborts the run promptly, §4.1); trigger already gone → proceed (benign race) |
| in_review | swap `herdr:in-development` → `herdr:in-review` | DELETE-of-absent-label 404 → treat as removed (documented); **closed issue → stale("issue closed before review")** — at in_review time the PR hasn't merged, so a closed issue is unambiguously a human cancel signal; park, don't proceed (DP-13) |
| merged / done | strip state labels; if open AND `close_on.*`: `PATCH state=closed, state_reason=completed` | already closed (auto-close won the race) → noop — benign by construction; **never reopen** |
| aborted | strip in-flight labels; add `herdr:aborted`; issue stays OPEN (visible, retriageable — OpenHands prior art); `close_on.aborted` → close as `not_planned` | closed → noop |

- **Closure ownership: BOTH** — `prompts/github_issues/pr.md` mandates the closing-keyword line
  (instant linkage + timeline UX) AND the transition backstop guarantees closure for the cases
  auto-close misses: non-default-branch PRs, keyword typos, and repos with the
  "auto-close issues with merged linked PRs" setting disabled. Safe because the write is
  GET-diff-apply idempotent.
- **Re-claim (INV-1)**: delivered `in_development` removes the trigger label → item drops out of
  listEligible. Delivery lag is covered by the pending-write-back + active-run guards.
- **Human affordances**: retry an aborted item = re-add `trigger_label`; re-run merged work =
  reopen + re-add trigger.
- **Labels created lazily** — memoized `ensureLabel` (GET → 404 → POST, tolerate 422-exists), so a
  fresh repo works on first claim. (Spike: if POST `/issues/{n}/labels` auto-creates missing
  labels, drop ensureLabel.)
- **Auto-close vs outbox**: the `merged` intent may arrive after `Fixes #n` already closed the
  issue — transition GETs, sees closed+completed, strips any leftover state labels (that alone →
  applied; nothing → noop). PR merge detection by branch (reconcile.ts:916) remains the real
  signal; issue state is a projection.

### 3.4 Claiming + crash recovery

Claiming stays store-arbitrated (INV-10): the run row + tick lock are the lock; the label swap is
the projection, delivered via the outbox (retry-safe per INV-2). Crash windows: (a) crash between
run creation and delivery — active-run + pending-write-back guards prevent re-claim; the outbox
converges after restart; (b) DB loss with labels already swapped — issues sit trigger-less with
`herdr:in-development`; recovery = re-add the trigger (documented runbook; automated orphan sweep
deferred, DP-7). Rejected: claim-marker comments + read-back verify — they spend content-creation
budget to shrink (not close) a race INV-10 already documents away.

### 3.5 listEligible

`GET /repos/{o}/{r}/issues?labels=<trigger>&state=open&sort=created&direction=asc&per_page=100`,
up to `max_pages`; drop entries with a `pull_request` key (the list endpoint interleaves PRs);
drop in-flight state labels; map to `GithubIssuesMatchItem` (key = `String(issue.number)`,
displayKey = `#<n>`). Hard failures throw (engine degrades per source). **Never the Search API**
(30/min budget + eventually-consistent index — fatal for claim decisions). No ETags in v1 —
1-10 requests/tick ≈ 60-600 req/hr against 5,000/hr; a documented follow-up, not a correctness
need (DP-6). Overflow beyond `max_pages`×100 defers to later ticks; oldest-first guarantees
eventual surfacing.

### 3.6 Keys / describe

Key = bare issue number string (`"123"`): shell-token-safe, git-ref-clean (`fix/123-slug-uid`),
URL-path-safe. Cross-source collisions are already handled — dedup is (repo, source, key)-scoped
and embedded CLI commands carry `--source` (step.ts:227-229). `describe`: GET issue
(redirect: manual — 301/410/404 throw with actionable messages); throws on `pull_request`
presence; `type` = native issue type / type_labels / default_type per DP-11.

### 3.7 materialize (prompt symmetry)

Idempotent on `memDir/task.md`. GET issue + all comments paginated with
`Accept: application/vnd.github.full+json` and render one `task.md`:

- Header: `# Issue #<n>: <title>`, url, labels, author, state, and a **`Closing reference:`** line
  the pr prompt copies verbatim — `Fixes #<n>` when the issue repo IS the PR repo, else
  `Fixes <owner>/<repo>#<n>` (the docs only show the full form cross-repo; same-repo full-form
  linkage is a spike item, so emit the docs-guaranteed short form when possible).
- Body + `## Comments`, skipping marker-bearing bot comments and sanitizing untrusted text (strip
  HTML comments + invisible chars — claude-code-action precedent, INV-4).
- **Media download — parse URLs from `body_html`, not the raw body**: on private repos, raw-body
  `github.com/user-attachments/assets` URLs 404 under PATs; `body_html` carries JWT-signed
  `private-user-images.githubusercontent.com` URLs that work. Host allowlist:
  `private-user-images.githubusercontent.com`, `user-images.githubusercontent.com`,
  `camo.githubusercontent.com`, `github.com/user-attachments`. **Download immediately after the
  API fetch** — the JWTs expire in minutes. Fall back to raw-body URLs for public repos. Jira caps
  apply (12 files / 10MB image / 50MB video); rewrite links to local paths, footnote failures,
  log-don't-throw. Attachment fetches keep `redirect: "follow"`.
- Raw `issue.json` sidecar `{issue, comments}`.

`workDoc()` → `{ path: "task.md", kind: "GitHub issue (markdown: title, body, all comments; raw
JSON in issue.json; media in attachments/)" }`.

### 3.8 Human-question loop

- **postNote**: POST comment `[herdr-factory] <note>`.
- **askHuman**: idempotent per questionId — scan recent comments for
  `[herdr-factory question: <repo>/<runId>/<questionId>]` (outside blockquotes); found → return
  its id; else POST the Jira-shaped question body ending **"Reply in a NEW comment —
  herdr-factory resumes automatically."** → `{ externalId, externalCreatedAt }`. 301/410/404 →
  `StaleItemError`.
- **pollHumanReply**: `GET /issues/{n}/comments?since=<externalCreatedAt>`; drop:
  `id === externalId`; any body whose NON-BLOCKQUOTE lines contain `[herdr-factory` (covers
  questions AND notes; a marker appearing only inside `> ` quote-reply lines does NOT disqualify —
  that comment IS the operator's reply); `created_at <= externalCreatedAt` (guards `since`'s
  updated_at semantics and the edited-old-comment trap). First survivor → HumanReply (author for
  display only). **NO author filtering** (INV-6). 301/410/404 → `StaleItemError`.

### 3.9 health / doctor

`health()`: GET `/repos/{o}/{r}` (auth + reachability; assert issues enabled +
`permissions.push`), then GET the trigger label — actionable messages ("token lacks access to X" /
"trigger label 'herdr' does not exist — create it or set trigger_label"). Doctor additions
(registry-generic): the secrets-manifest presence check replaces the Jira-only block
(doctor.ts:123-129); fail-fast when a github_issues source is configured and `repo ?? ghRepo`
resolves empty (buildDeps also throws at construction).

---

## 4. Engine changes (the reconciler stays source-agnostic)

### 4.1 Two-phase stale handling — the lock-discipline fix

`deliverTransition` (reconcile.ts:32-54) is invoked from the Phase-0 outbox flush **without a run
lock** — it must never mutate runs. The stale policy is therefore two-phase:

1. **Outbox phase (lock-free)**: on `stale` — mark the intent delivered, record a `stale` event
   with the detail, and set a per-run flag (e.g. `stale_pending` on the intent row or a run
   column). No phase flips, no teardown, no postNote from here.
2. **Phase A (under `withRunLock`)**: the per-run reconcile consumes the flag —
   - run **active, not tearing down**, stale was on a **pre-terminal** intent (`in_development` /
     `in_review`): teardown(`abandoned`) + escalate attention. This bounds token spend promptly
     (the first agent may already be running — the claim transition fires AFTER spawnStep,
     reconcile.ts:543-556 — so "promptly", not "before any tokens").
   - run **ended / tearing down**: record an event + warn log only. Never flip an ended run's
     phase, never notify, never postNote against an item the source just reported gone.
   - **suppress escalation for terminal intents of a run whose abort was itself stale-caused**
     (check for a prior stale event on the run) — otherwise one deleted issue produces teardown's
     `aborted` intent → stale again → a second notification.

### 4.2 Human-loop resilience

`reconcileWaitingForHuman` (reconcile.ts:843-874): wrap `pollHumanReply`/`askHuman` in try/catch —
- `StaleItemError` → escalate attention (the item is gone; a parked run must not poll a
  nonexistent issue every 5min forever, invisible because waiting_for_human runs don't count
  against capacity, store.ts:217-224).
- any other throw → count as a poll miss (60s→5min backoff) + warn, instead of bubbling to the
  Phase-A per-run catch (pre-empts a rate-limited GitHub making that path hot every tick).
- backstop: N consecutive poll failures (e.g. 20) → escalate attention.

### 4.3 workDoc plumbing

`renderStepPrompt` (step.ts:202-215): `telemetrySpanSync` → `telemetrySpan`, the function goes
async, `await src.client.workDoc(join(worktree, MEMORY_DIR))`, awaited from `spawnStep`. The
type-switch at step.ts:243-253 is deleted. **Integration test required**: render a step prompt
through a `buildDeps`-style `instrumentObject`-wrapped source — the unwrapped fakes in the
contract suite cannot catch proxy-induced Promise leaks.

### 4.4 Manual-claim key echo (INV-11)

`claimTicket` (reconcile.ts:1242-1246) re-checks `activeRunForTicket` against **`describe()`'s
returned key** before claiming (3 lines) — closes the double-claim hole for any source that
normalizes alternate identifiers (Linear "ENG-123" → UUID).

### 4.5 buildDeps / config

Registry loop replaces the construction ternary (build-deps.ts:60-73). `Deps.secrets: Secrets` →
`Deps.env: Readonly<Record<string, string>>` — **the field lives in core/deps.ts:132-149**, listed
under Stage 1's deps.ts row (not build-deps). `loadSecrets` → `loadEnvMap` (config.ts:279-282,
:542-562 — same chmod-600 file, same keys on disk, zero user break). The hardcoded
`WorkSourceConfig` shape (config.ts:303-308) and `Config.sources` (config.ts:366) become the
registry-generic resolved-source shape in Stage 2.

---

## 5. Implementation plan (5 stages, one PR-train)

**Stage 1 — Contract v2 + charter + contract suite** (compile-forced; no behavior change for
existing sources beyond the two deliberate fixes: Jira marker filter + marked postNote):

| # | File | Change |
|---|------|--------|
| 1 | src/types.ts | Ticket +displayKey/url; MatchItem → generic base + per-source interfaces + guards; ticketOf union-free; StaleItemError; TransitionResult; WorkDocInfo |
| 2 | src/core/deps.ts | WorkSource v2 (spec, async workDoc, TransitionResult, StaleItemError semantics); INV-1..11 charter replaces :66-94; `Deps.secrets` → `Deps.env` |
| 3 | src/clients/jira-source.ts | spec; workDoc; transition → TransitionResult; postNote `[herdr-factory]` prefix; **pollHumanReply skip predicate widened to blockquote-aware `[herdr-factory`** |
| 4 | src/clients/local-markdown-source.ts | spec; workDoc (fs sniff from step.ts:249-252); transition → TransitionResult; listEligible +labels/fields + INV-7 unsafe-key skip |
| 5 | src/core/step.ts | :243-253 → `await src.client.workDoc(...)`; renderStepPrompt async (telemetrySpanSync → telemetrySpan) |
| 6 | src/core/reconcile.ts | two-phase stale (§4.1); human-loop resilience (§4.2); claimTicket key-echo recheck (§4.4) |
| 7 | src/db/store.ts | stale_pending flag surface for §4.1 (intent row or run column) |
| 8 | test/work-source-contract.test.ts | NEW — parametrized charter suite (§6) |
| 9 | test/reconcile.test.ts | fakes updated (compile-forced); new engine cases (§6) |
| 10 | test/jira-source.test.ts | boolean transition assertions → TransitionResult; marked-postNote + widened-filter cases; note which cases migrate into the contract suite |
| 11 | test/local-markdown-source.test.ts | signature updates; labels/fields; unsafe-key skip case |

**Stage 2 — Registry + secrets generalization** (pure reshuffle; config.schema.json must stay
byte-identical — the sync test at test/config.test.ts:555-560 is the guard):

| # | File | Change |
|---|------|--------|
| 12 | src/sources/registry.ts | NEW — SOURCE_TYPES/SourceType, SourceDescriptor, descriptor array |
| 13 | src/sources/{jira,local-markdown}/descriptor.ts | NEW — schema/resolve/create/secrets/tui moved from config.ts + build-deps.ts + tui/config-fields.ts |
| 14 | src/config.ts | union from registry (:84-88); resolver loop (:618-635); WorkSourceConfig (:303-308) + Config.sources (:366) → registry-generic; Secrets → loadEnvMap (:279-282, :542-562) |
| 15 | src/build-deps.ts | registry loop (:60-73); env threading |
| 16 | src/doctor.ts | generic manifest check replaces :123-129 |
| 17 | src/tui/config-fields.ts, config-editor.ts | render from descriptor.tui + manifests |

**Stage 3 — GitHub Issues source:**

| # | File | Change |
|---|------|--------|
| 18 | src/clients/github-budget.ts | NEW — process-wide read bucket + dual (per-min + per-hour) mutation buckets |
| 19 | src/clients/http.ts | `HttpRequest.redirect?: "follow"\|"manual"` (default follow); `HttpPolicy.isRetryable?` override; bounded 403-secondary sleeps |
| 20 | src/clients/github-issues.ts | NEW — REST client: token bootstrap (env → gh auth token, 401 refresh), buckets, redirect:manual API calls with 301/410/404 → stale mapping, list/get/comments/labels/close/ensureLabel, body_html media download, x-ratelimit-reset handling |
| 21 | src/clients/github-issues-source.ts | NEW — GithubIssuesSource per §3 |
| 22 | src/sources/github-issues/descriptor.ts | NEW — schema, resolveConfig, create (throws when repo ?? ghRepo empty), secrets manifest, tui block |
| 23 | src/clients/github.ts | (optional) sync read-bucket acquire before gh execs |
| 24 | config.schema.json | `npm run schema` (test-enforced) |
| 25 | test/github-issues-source.test.ts | NEW — fetch-stub harness cloned from jira-source.test.ts:22-31 |
| 26 | test/config.test.ts | github_issues validation + schema round-trip |
| 27 | test/reconcile.test.ts | github fake registered; belt routing on labels |

**Stage 4 — Prompts (atomic):**

| # | File | Change |
|---|------|--------|
| 28 | src/prompts/jira/fix.md | MOVED from src/prompts/fix.md (the shared fix.md is Jira-flavored today — "one Jira ticket", ticket.json, fields.comment) |
| 29 | src/prompts/fix.md | NEW neutral shared fix prompt (@@WORK_DOC@@/@@WORK_DOC_KIND@@) |
| 30 | src/prompts/github_issues/{fix,pr}.md | NEW — pr.md mandates copying the Closing-reference line; notes auto-close fires only on default-branch PRs |

**Stage 5 — Docs + examples** (repo convention: docs sync in the same train):

| # | File | Change |
|---|------|--------|
| 31 | docs/ARCHITECTURE.md | work-sources section (:270-301) rewritten for contract v2 + registry + github-issues client; :14-16 ("two types ship today"), :177 (prompt matrix), :767-772 (type enum) |
| 32 | README.md | work_sources reference gains github_issues; env-file section gains GITHUB_TOKEN (":322 Jira auth only" is wrong after Stage 2); quick-start acknowledges the non-Jira path |
| 33 | examples/example-repo/config.yml, match-bugs.ts | type-enum comment; MatchItem shape docs → generic base + guards; commented github_issues block |

**NO changes**: db/migrate.ts (runs.ticket_key/work_source/outbox/questions are opaque;
github_issues never touches work_items — §4.1's flag may add one nullable column, decided at
implementation), install.sh, src/tui/doctor.ts, server.

**Pre-implementation spikes** (~30 min with a scratch repo):
1. body_html JWT attachment URLs on a private repo (acceptance: download works immediately after
   fetch; note observed JWT expiry).
2. POST `/issues/{n}/labels` behavior for repo-missing labels (drop ensureLabel if it auto-creates).
3. Same-repo full-form `Fixes owner/repo#n` linkage (if unsupported, the short-form emission in
   §3.7 already covers it).
4. Auto-close timing after merge (how fast the issue closes vs the outbox's merged intent).

---

## 6. Test plan

**Shared contract suite** (`test/work-source-contract.test.ts`, parametrized over all three
sources with per-source fake backends — fetch stub for jira/github_issues, real fs + in-memory
Store for local_markdown):

1. listEligible [] when empty
2. items carry sourceType/key/summary/type non-empty; key matches the INV-7 safety regex
3. listEligible excludes claimed/in-flight/terminal items — and skips+warns on unsafe keys
4. transition already-there → noop, no mutating call
5. transition differs → applied + exactly one logical mutation
6. transition unmapped → noop with ZERO backend calls (asserted against spec.mappedStates — the
   load-bearing teardown-silence test)
7. transition idempotent on re-call
8. describe throws on unknown key; returned key echoes canonical form (INV-11)
9. materialize idempotent + non-throwing on vanished item
10. *(replyChannel: "comments" only)* askHuman returns durable externalId + marker-bearing body,
    idempotent per questionId
11. *(replyChannel: "comments" only)* pollHumanReply skips the question, marker-bearing postNote
    output, and anything created ≤ question; **returns a quote-reply-shaped comment
    (`> [herdr-factory question: …]` + non-quoted answer) as a genuine reply**; null when none
12. *(replyChannel: "file")* local_markdown: answer-section extraction; notes file never read as
    a reply
13. health throws actionably on misconfig; resolves healthy
14. workDoc never throws, pre- and post-materialize
15. **integration: workDoc through an instrumentObject-wrapped source renders real tokens**

**GitHub-specific** (fetch-stub): PR-contamination filter; in-flight state-label exclusion;
oldest-first + max_pages; full transition table incl. closed-before-claim → stale, **301 → stale
with zero mutations issued**, **410 → stale**, 404 → stale, auto-close race (merged on closed →
label-strip or noop), DELETE-absent-label 404 tolerated, never-reopen, in_review-on-closed →
stale; ensureLabel lazy create + 422 tolerance; close_on flags incl. aborted → not_planned;
type resolution (native type / type_labels / default_type per DP-11); materialize renders task.md
with the correct short/full Closing-reference form, sanitizes HTML comments/invisible chars, skips
bot comments, parses media from body_html with the four-host allowlist, caps attachments,
footnotes failures, writes issue.json; askHuman search-before-post; pollHumanReply blockquote
rules + does NOT drop same-login replies; 403+Retry-After retried bounded, 401 → token refresh
once; hourly mutation bucket enforced; health messages.

**Engine** (reconcile.test.ts): transition-noop silent; stale two-phase — flag set lock-free,
teardown/escalation only under the run lock, no phase flip on ended runs, no double-notification
on the stale-abort path; StaleItemError from pollHumanReply/askHuman → attention; generic
pollHumanReply throw → backoff not error-path; N-miss backstop; listEligible-throw doesn't starve
the other source; claimTicket key-echo dedup; github fake claims through belt routing on labels.

**Config**: github_issues parse/defaults/strict-unknown-key; duplicate names; belt→source
resolution; config.schema.json sync; Stage-2 byte-identical schema guard.

---

## 7. DECISION POINTS — choose before Stage 1

| # | Decision | Recommendation |
|---|----------|----------------|
| DP-1 | `transition` → TransitionResult vs keep boolean | **TransitionResult** — fixes retry-forever for GitHub AND Jira; the portability shape. Fallback (less churn): boolean + loud-log accepts eternal-1h-retry as a runbook item |
| DP-2 | Auto-abort the run on stale(pre-terminal) | **Yes** — a human closing/deleting the issue means "don't do this work"; false-positive costs one re-trigger label |
| DP-3 | Registry now vs extend the 3-way switches | **Registry** (Stage 2, own commit, schema-byte-identical guard) — the structural answer to "Linear plugs in cleanly". Fallback: switch extensions; costs a second refactor at source #4 and leaves Secrets Jira-shaped |
| DP-4 | MatchItem generic base vs extend the closed union | **Generic base + guards** — zero central edits per source; accepted DX loss: no automatic exhaustive narrowing in match.ts |
| DP-5 | `aborted` leaves the issue OPEN + `herdr:aborted` | **Yes** (retriageable failure artifact, OpenHands prior art); `close_on.aborted: false` default. Alternative: close as not_planned (quieter boards, hides failures) |
| DP-6 | ETag conditional requests | **Defer** — 60-600 req/hr vs 5,000/hr; benefit unverified |
| DP-7 | Orphan sweep in health() (state-labeled issues with no live run) | **Defer to v1.1** — store handle already in SourceBuildCtx; runbook meanwhile |
| DP-8 | Auth default | **gh-CLI token with optional GITHUB_TOKEN override** (no auth: config knob). Accepts shared identity ⇒ marker-only reply filtering (INV-6). A dedicated bot account is just GITHUB_TOKEN in the env file |
| DP-9 | Type literal | **`github_issues`** — avoids repo.github/GitHubApi collisions; leaves room for github_* siblings |
| DP-10 | displayKey | **Contract field only, no DB migration/@@DISPLAY_KEY@@ token now** — `#123` is derivable; persist only when Linear lands |
| DP-11 | Issue type derivation | **Prefer GitHub's native issue type** (`issue.type?.name`, GA for orgs) when present → type_labels → default_type. An org using native Bug/Task/Feature without duplicate labels would otherwise get `feature/` branches for every bug |
| DP-12 | Trigger-label semantics | **Consume-at-claim** (label = one-shot queue token; retry = re-add). Alternative: persistent trigger + state-label gating (label = ownership marker; different INV-1 story — convergence would then depend on state-label writes). Materially changes operator workflow — flagging explicitly |
| DP-13 | in_review transition finds the issue closed | **stale("issue closed before review") → park for a human** — pre-merge, a closed issue is unambiguously a cancel signal (auto-close only fires on merge); proceeding burns reviewer attention on killed work. Alternative: noop + proceed |

---

## 8. Rejected alternatives (with reasons)

- **Author-identity reply filtering** — with gh-CLI shared credentials the bot login IS the
  operator's login; would silently swallow every genuine reply (the decisive cross-design catch).
- **Search API for listEligible** — 30/min budget + eventually-consistent index; fatal for claim
  decisions.
- **Claim-marker comments + read-back verify** — spends content-creation budget to shrink (not
  close) a race INV-10 documents away.
- **Hidden HTML-comment markers** — diverges from the established visible `[herdr-factory`
  convention and from materialize's own HTML-comment stripping.
- **`SourceType → string`** — forfeits config/TUI exhaustiveness that the registry-derived closed
  union preserves at identical extension cost.
- **Assignee-based claiming / Projects v2 status fields** — assignee requires a distinct bot
  identity (conflicts with DP-8's default) and collides with human assignment conventions;
  Projects v2 is GraphQL-only, org-coupled, and adds a second state store.
- **gh CLI as the issues transport** — no typed status codes (301/410 mapping impossible), no
  reuse of the tested throttle/retry machinery, exec overhead per call.
- **Webhooks** — the factory may run on a laptop behind NAT; polling is the deployment-honest
  choice. Revisit only if a hosted mode appears.
