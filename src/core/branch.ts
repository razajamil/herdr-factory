/** Map a Jira issue type to a branch prefix. Substring match handles "Dev bug" etc. */
export function prefixForType(type: string): string {
  const t = type.toLowerCase();
  if (/bug|defect/.test(t)) return "fix";
  if (/chore|task/.test(t)) return "chore";
  return "feature";
}

/** e.g. fix/RWR-1234-short-kebab-summary */
export function branchName(key: string, type: string, summary: string): string {
  const slug = summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
  return `${prefixForType(type)}/${key}-${slug || "work"}`;
}
