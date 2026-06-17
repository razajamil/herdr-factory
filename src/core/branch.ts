/** Map a Jira issue type to a branch prefix. Substring match handles "Dev bug" etc. */
export function prefixForType(type: string): string {
  const t = type.toLowerCase();
  if (/bug|defect/.test(t)) return "fix";
  if (/chore|task/.test(t)) return "chore";
  return "feature";
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
export const DEFAULT_WORKSPACE_NAME = "{{ticket_prefix}}/{{ticket_id}}-{{ticket_slug}}";

export interface TicketVars {
  key: string;
  type: string;
  summary: string;
}

/** Variables a `workspace_name` template can interpolate. */
export function ticketVars(t: TicketVars): Record<string, string> {
  return {
    ticket_id: t.key, // e.g. RWR-17202 (case preserved)
    ticket_type: t.type.toLowerCase(), // e.g. bug, story
    ticket_prefix: prefixForType(t.type), // fix | chore | feature
    ticket_slug: slugify(t.summary, 50) || "work", // full title slug
    ticket_short_slug: slugify(t.summary, 20) || "work", // title slug capped at 20
  };
}

/**
 * Render a `workspace_name` template into a git-safe branch name. The worktree +
 * workspace derive from this branch (herdr assigns the workspace id). Unknown
 * `{{vars}}` render empty; the output is sanitised to a valid-ish ref.
 */
export function renderWorkspaceName(template: string, t: TicketVars): string {
  const vars = ticketVars(t);
  const out = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => vars[name] ?? "");
  const safe = out
    .replace(/[\x00-\x20~^:?*[\]\\]+/g, "-") // whitespace + git-illegal chars → dash
    .replace(/\.{2,}/g, ".") // collapse ".." (illegal in refs)
    .replace(/-{2,}/g, "-") // collapse dashes
    .replace(/\/{2,}/g, "/") // collapse slashes
    .replace(/-*\/-*/g, "/") // tidy dashes hugging a slash
    .replace(/^[-./]+|[-./]+$/g, ""); // trim leading/trailing separators
  return safe || `${prefixForType(t.type)}/${t.key}`;
}

/** Branch name for a cat. `template` defaults to the historical naming when unset. */
export function branchName(key: string, type: string, summary: string, template?: string): string {
  return renderWorkspaceName(template || DEFAULT_WORKSPACE_NAME, { key, type, summary });
}
