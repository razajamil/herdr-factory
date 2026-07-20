/** The resolved branch-naming taxonomy: how a work-item type maps to `{{semantic_work_prefix}}`, and
 *  the length caps for the `{{work_slug}}` / `{{work_full_slug}}` vars. Resolved in src/config.ts
 *  (belt over repo over {@link DEFAULT_BRANCH_TAXONOMY}); everything here takes it as a value so the
 *  taxonomy is no longer a core literal. */
export interface BranchTaxonomy {
  /** work-type (key) → branch prefix. A type matches a key case-insensitively by SUBSTRING (so
   *  "Dev bug" matches "bug"), keys tried in declaration order (first match wins). No `default` key
   *  lives here — the fallback is {@link BranchTaxonomy.default}. */
  prefixes: Record<string, string>;
  /** Prefix for a type that matches no `prefixes` key. */
  default: string;
  /** Cap for `{{work_slug}}`. */
  slugMax: number;
  /** Cap for `{{work_full_slug}}`. */
  fullSlugMax: number;
}

/** The historical taxonomy, reproducing the hardcoded `bug|defect → fix`, `chore|task → chore`, else
 *  `feature` mapping and the 20/50 slug caps. Used whenever no `branch:` block is configured, so
 *  branch names stay byte-identical to before. */
export const DEFAULT_BRANCH_TAXONOMY: BranchTaxonomy = {
  prefixes: { bug: "fix", defect: "fix", chore: "chore", task: "chore" },
  default: "feature",
  slugMax: 20,
  fullSlugMax: 50,
};

/** Map a work-item type to a branch prefix via the resolved taxonomy. The type is matched against
 *  each `prefixes` key case-insensitively by substring (so "Dev bug" matches the "bug" rule), first
 *  match winning; an unmatched type falls to the taxonomy's `default`. */
export function prefixForType(type: string, taxonomy: BranchTaxonomy = DEFAULT_BRANCH_TAXONOMY): string {
  const t = type.toLowerCase();
  for (const [key, prefix] of Object.entries(taxonomy.prefixes)) {
    if (t.includes(key.toLowerCase())) return prefix;
  }
  return taxonomy.default;
}

/** lowercase kebab slug of `s`, capped at `max` chars (no trailing dash). */
export function slugify(s: string, max: number): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

/** Default workspace_name — reproduces the historical fix|chore|feature/KEY-slug naming. */
export const DEFAULT_WORKSPACE_NAME = "{{semantic_work_prefix}}/{{work_id}}-{{work_full_slug}}";

export interface TicketVars {
  key: string;
  type: string;
  summary: string;
}

/** Variables a `workspace_name` template can interpolate. (Generic across work sources — a "work
 *  item" may be a Jira ticket, a markdown brief, …) The resolved {@link BranchTaxonomy} feeds
 *  `{{semantic_work_prefix}}` and the slug caps; it defaults to the historical taxonomy so a caller
 *  with no config gets today's names. */
export function ticketVars(t: TicketVars, taxonomy: BranchTaxonomy = DEFAULT_BRANCH_TAXONOMY): Record<string, string> {
  return {
    work_id: t.key, // e.g. RWR-17202 (case preserved)
    work_type: t.type.toLowerCase(), // e.g. bug, story
    semantic_work_prefix: prefixForType(t.type, taxonomy), // taxonomy default: fix | chore | feature
    work_full_slug: slugify(t.summary, taxonomy.fullSlugMax) || "work", // full title slug (default <=50)
    work_slug: slugify(t.summary, taxonomy.slugMax) || "work", // title slug (default capped at 20)
  };
}

/**
 * Substitute `{{work_id}}` / `{{work_slug}}` / … in a free-form template using the same work-item
 * vars a `workspace_name` interpolates (see {@link ticketVars}). Unknown `{{vars}}` render empty.
 * This is the raw substitution ONLY — NO git-ref sanitisation (that's {@link renderWorkspaceName}),
 * so it suits prose templates like a PR title where spaces and punctuation are wanted verbatim.
 */
export function renderWorkVars(template: string, t: TicketVars, taxonomy: BranchTaxonomy = DEFAULT_BRANCH_TAXONOMY): string {
  const vars = ticketVars(t, taxonomy);
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => vars[name] ?? "");
}

/**
 * Render a `workspace_name` template into a git-safe branch name. The worktree +
 * workspace derive from this branch (herdr assigns the workspace id). Unknown
 * `{{vars}}` render empty; the output is sanitised to a valid-ish ref.
 */
export function renderWorkspaceName(template: string, t: TicketVars, taxonomy: BranchTaxonomy = DEFAULT_BRANCH_TAXONOMY): string {
  const out = renderWorkVars(template, t, taxonomy);
  const safe = out
    .replace(/[\x00-\x20~^:?*[\]\\]+/g, "-") // whitespace + git-illegal chars → dash
    .replace(/\.{2,}/g, ".") // collapse ".." (illegal in refs)
    .replace(/-{2,}/g, "-") // collapse dashes
    .replace(/\/{2,}/g, "/") // collapse slashes
    .replace(/-*\/-*/g, "/") // tidy dashes hugging a slash
    .replace(/^[-./]+|[-./]+$/g, ""); // trim leading/trailing separators
  return safe || `${prefixForType(t.type, taxonomy)}/${t.key}`;
}

/** Branch name for a cat. `template` defaults to the historical naming when unset. A `uid` (a short
 *  per-run unique suffix) is appended when given, so each claim — including a RE-claim of a ticket
 *  whose prior branch was already merged — gets a distinct branch. That's what keeps the pr step's
 *  `prForBranch` poll matching the CURRENT attempt's PR rather than a stale merged one on a reused
 *  branch name. */
export function branchName(
  key: string,
  type: string,
  summary: string,
  template?: string,
  uid?: string,
  taxonomy: BranchTaxonomy = DEFAULT_BRANCH_TAXONOMY,
): string {
  const base = renderWorkspaceName(template || DEFAULT_WORKSPACE_NAME, { key, type, summary }, taxonomy);
  return uid ? `${base}-${uid}` : base;
}
