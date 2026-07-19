import { z } from "zod";

/** The type-agnostic fields every source object carries, spread into each descriptor's `.strict()`
 *  configSchema so they pass validation there (the config schema is a discriminated union of
 *  per-type objects — a common key must be declared on each member, not smuggled past `.strict()`).
 *  - `name` — the optional unique identity (default = type).
 *  - `poll_interval_seconds` — how often THIS source is polled for new work (the `listEligible` call
 *    in Phase B); overrides `limits.source_poll_interval_seconds`. Both are pulled up into the
 *    WorkSourceConfig envelope by loadConfig, resolving the repo default (itself defaulting to the
 *    tick interval).
 *  - `max_active_workspaces` — per-source concurrency cap: the most WORKED workspaces this source
 *    may have in flight at once, summed across every belt that pulls from it. Phase B walks belts in
 *    priority order and stops claiming from a source once it hits this cap, so the repo-wide
 *    `limits.max_active_workspaces` is still the ceiling on total workspaces but no single source can
 *    monopolize it. Defaults to 2.
 *
 *  Lives in its own module (not registry.ts) to avoid a load-order cycle: registry.ts imports the
 *  descriptors, and the descriptors import this — a shared const on registry.ts would be in its
 *  temporal dead zone when a descriptor module first evaluates. */
export const commonSourceFields = {
  name: z.string().trim().min(1).optional(),
  poll_interval_seconds: z.coerce.number().int().positive().optional(),
  max_active_workspaces: z.coerce.number().int().positive().default(2),
};
