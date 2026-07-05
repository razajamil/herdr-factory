// The work-source REGISTRY: one descriptor per source type, and the single edit surface for
// adding a new one. Everything type-specific that used to be a switch scattered across
// config.ts / build-deps.ts / doctor.ts / the TUI now lives on the descriptor.
//
// ── Adding source N+1 (the whole checklist) ──────────────────────────────────────────────────
//  1. src/clients/<type>-source.ts        — the WorkSource implementation (+ its client)
//  2. src/sources/<type>/descriptor.ts    — schema / resolveConfig / create / secrets / tui
//  3. one literal in SOURCE_TYPES         — src/types.ts (keeps the closed union honest)
//  4. one entry in SOURCE_DESCRIPTORS     — below
//  5. `npm run schema`                    — regenerate config.schema.json (test-enforced)
//  6. register a harness in test/work-source-contract.test.ts (the charter suite)
//  7. optional: src/prompts/<type>/<step>.md overrides; a MatchItem convenience interface +
//     guard in src/types.ts for user match.ts files
// Zero other core edits — anything more means the abstraction leaked; fix the leak instead.
import type { ZodType } from "zod";
import type { Store } from "../db/store.ts";
import type { Logger, WorkSource } from "../core/deps.ts";
import type { SourceType } from "../types.ts";
import { githubIssuesDescriptor } from "./github-issues/descriptor.ts";
import { jiraDescriptor } from "./jira/descriptor.ts";
import { localMarkdownDescriptor } from "./local-markdown/descriptor.ts";

/** One secret a source reads from the per-repo env file. Drives doctor's presence check and the
 *  TUI's credential rows — the engine itself never interprets these. */
export interface SecretSpec {
  envKey: string; // key in the per-repo env file ("JIRA_API_TOKEN", "GITHUB_TOKEN")
  required: boolean; // doctor fails when required and absent
  masked?: boolean; // TUI renders the value masked
  placeholder?: string; // TUI placeholder
  hint: string; // doctor's remediation message
}

/** One editable field of a source's type block, rendered by the TUI config editor. `path` is
 *  relative to the SOURCE OBJECT (e.g. ["jira", "base_url"]). */
export interface TuiFieldSpec {
  label: string;
  path: string[];
  placeholder?: string;
  numeric?: boolean;
}

/** Everything a descriptor's create() gets to build a live client. */
export interface SourceBuildCtx<TCfg> {
  repoName: string;
  sourceName: string; // resolved name ?? type — the durable FK (INV-9)
  cfg: TCfg; // this source's resolved camelCase block
  env: Readonly<Record<string, string>>; // the per-repo env file
  store: Store; // internal ledgers (local_markdown's work_items; future orphan audits)
  ghRepo: string; // resolved PR repo "owner/name" or "" when unresolvable
  log: Logger;
}

export interface SourceDescriptor<TCfg = unknown> {
  readonly type: SourceType;
  /** The FULL `.strict()` source object schema: { type: literal, name?, <type>: block }. Joined
   *  into the config discriminated union; flows into config.schema.json via `npm run schema`. */
  readonly configSchema: ZodType;
  /** snake_case parse output (the whole source object) → resolved camelCase block. */
  resolveConfig(parsed: Record<string, unknown>): TCfg;
  /** Construct the live client (build-deps wraps it in instrumentObject). MAY throw on an
   *  unbuildable config (e.g. no repo resolvable) — startup should fail loudly, not at claim time. */
  create(ctx: SourceBuildCtx<TCfg>): WorkSource;
  readonly secrets: readonly SecretSpec[];
  readonly tui: { defaultBlock(): Record<string, unknown>; fields: readonly TuiFieldSpec[] };
}

// The array is heterogeneous (each descriptor has its own TCfg); `any` here is the variance
// escape hatch — every consumer goes through descriptorFor() and the untyped `cfg` handoff.
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous descriptor collection
export type AnySourceDescriptor = SourceDescriptor<any>;

// jira MUST stay first with default name "jira" (db/migrate.ts v6 backfill invariant + the
// generated config.schema.json's union order, which the schema-sync test pins byte-for-byte).
export const SOURCE_DESCRIPTORS: readonly AnySourceDescriptor[] = [jiraDescriptor, localMarkdownDescriptor, githubIssuesDescriptor];

export function descriptorFor(type: SourceType): AnySourceDescriptor {
  const d = SOURCE_DESCRIPTORS.find((x) => x.type === type);
  if (!d) throw new Error(`no source descriptor registered for type "${type}"`); // unreachable: SourceType is closed
  return d;
}
