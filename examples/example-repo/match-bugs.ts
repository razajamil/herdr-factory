// Example belt `match` predicate (referenced as `match: match-bugs.ts` in config.yml).
//
// The default export receives { item, source } and returns whether THIS belt should claim the
// item. Belts are walked in priority order at claim time; the FIRST belt whose predicate returns
// true claims the item (a belt with no `match` accepts anything from its source). The predicate
// may be sync or async.
//
// `item` is tagged by source type:
//   - jira:           { sourceType, key, summary, type, status, labels, fields }
//   - local_markdown: { sourceType, key, summary, type, path, filename, frontMatter, body }
//
// For editor autocomplete you can type it against the engine's contract (the import is type-only,
// so Node strips it at runtime and the path only matters to your editor):
//   import type { BeltMatch } from "herdr-factory/src/types.ts"
//   const matchBugs: BeltMatch = ({ item }) => { ... }

export default function matchBugs({ item }) {
  // This belt only handles Jira bugs/defects; anything else falls through to a later belt.
  if (item.sourceType !== "jira") return false;
  return /bug|defect/i.test(item.type) || item.labels.includes("bug");
}
