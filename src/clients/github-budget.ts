// PROCESS-WIDE GitHub REST budget. Module singletons on purpose: every repo runtime in this
// process spends the same authenticated user's rate budget (one PAT / gh login), so per-instance
// buckets would multiply the pressure by the repo count. The gh-CLI PR watcher shares the same
// primary budget but a different transport; only the REST issue traffic flows through here.
//
// Shapes guarded (docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api):
//  - primary: 5,000 req/hr for a PAT — reads ride this; the sustained read rate below is far under.
//  - secondary content-generating: 80/min AND 500/hr — mutations (comments, labels, close) chain
//    BOTH buckets; a per-minute bucket alone would allow ~3,600/hr, 7x the hourly cap.
// httpWithPolicy acquires the buckets per attempt (retries included) and records the wait time
// (herdr_factory.rate_limit.wait_ms), so budget back-pressure is visible, not a silent slowdown.
import { TokenBucket } from "./http.ts";

/** Reads: 5/s sustained, burst 10 — a claim-heavy tick's GET fan-out smooths to ~300/min peak,
 *  well inside the 5,000/hr primary. */
export const githubReadBucket = new TokenBucket(5, 10);

/** Mutations, per-minute half: ~60/min sustained (burst 2) under the 80/min secondary cap. */
export const githubMutationMinuteBucket = new TokenBucket(1, 2);

/** Mutations, per-hour half: 500/hr sustained (burst 10) — the documented hourly
 *  content-generating cap a saturated per-minute bucket would blow through. */
export const githubMutationHourBucket = new TokenBucket(500 / 3600, 10);

export const GITHUB_MUTATION_BUCKETS = [githubMutationMinuteBucket, githubMutationHourBucket] as const;
