import { z } from "zod";

/** The type-agnostic fields every source object carries, spread into each descriptor's `.strict()`
 *  configSchema so they pass validation there (the config schema is a discriminated union of
 *  per-type objects — a common key must be declared on each member, not smuggled past `.strict()`).
 *  - `name` — the optional unique identity (default = type).
 *  - `poll_interval_seconds` — how often THIS source is polled for new work (the `listEligible` call
 *    in Phase B); overrides `limits.source_poll_interval_seconds`. Both are pulled up into the
 *    WorkSourceConfig envelope by loadConfig, resolving the repo default (itself defaulting to the
 *    tick interval).
 *
 *  Lives in its own module (not registry.ts) to avoid a load-order cycle: registry.ts imports the
 *  descriptors, and the descriptors import this — a shared const on registry.ts would be in its
 *  temporal dead zone when a descriptor module first evaluates. */
export const commonSourceFields = {
  name: z.string().trim().min(1).optional(),
  poll_interval_seconds: z.coerce.number().int().positive().optional(),
};
