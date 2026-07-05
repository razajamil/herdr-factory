// Example belt `match` predicate (referenced as `match: match-bugs.ts` in config.yml).
//
// The default export receives { item, source } and returns whether THIS belt should claim the
// item. Belts are walked in priority order at claim time; the FIRST belt whose predicate returns
// true claims the item (a belt with no `match` accepts anything from its source). The predicate
// may be sync or async.
//
// `item` is a generic base every source shares — { sourceType, key, summary, type, labels,
// fields } (labels is always an array, [] when the backend has none; `fields` is the raw
// source-native payload) — extended per source:
//   - jira:           + { status }                                       (fields = raw issue.fields)
//   - local_markdown: + { path, filename, frontMatter, body }            (fields = front-matter)
//   - github_issues:  + { number, repo, state, assignees, author, body } (fields = raw REST issue)
//
// The engine exports type guards for narrowing — isJiraItem / isLocalMarkdownItem /
// isGithubIssuesItem (src/types.ts). Match files are loaded with a dynamic file-URL import, so a
// value import only resolves if you point it at the engine checkout by path; the plain
// `item.sourceType === "…"` comparison below is the dependency-free equivalent and narrows the
// same way. For editor autocomplete, a type-only import is erased at runtime and always safe:
//   import type { BeltMatch, GithubIssuesMatchItem } from "herdr-factory/src/types.ts"
//   const matchBugs: BeltMatch = ({ item }) => { ... }
// e.g. routing GitHub issues:  if (isGithubIssuesItem(item)) return item.labels.includes("bug");

export default function matchBugs({ item }) {
  // This belt only handles Jira bugs/defects; anything else falls through to a later belt.
  // (`item.sourceType === "jira"` is what the isJiraItem guard checks.)
  if (item.sourceType !== "jira") return false;
  return /bug|defect/i.test(item.type) || item.labels.includes("bug");
}
