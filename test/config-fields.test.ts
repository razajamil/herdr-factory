// The TUI config editor's field builder — specifically that a source's descriptor `tui.fields`
// render, including the new enum (pick-list) support that surfaces jira's auth.method.
import { describe, it, expect } from "vitest";
import { parseDocument, type Document } from "yaml";
import { buildDescriptors, type FieldDesc } from "../src/tui/config-fields.ts";

/** Build the field list with the given source expanded (its inner fields only render when open). */
function fieldsFor(doc: Document): FieldDesc[] {
  const expanded = new WeakSet<object>();
  const src = doc.getIn(["work_sources", 0]) as object;
  if (src) expanded.add(src);
  return buildDescriptors(
    doc,
    () => {},
    async () => true,
    expanded,
    "work_sources",
  );
}

const jiraDoc = () =>
  parseDocument(`work_sources:
  - type: jira
    jira:
      base_url: https://x.atlassian.net
      project: P
      board: "1"
belt: []
`);

describe("config-fields: jira auth.method", () => {
  it("renders auth.method as an enum (api_token | oauth), defaulting to api_token when unset", () => {
    const auth = fieldsFor(jiraDoc()).find((f) => f.kind === "enum" && f.label === "auth.method");
    expect(auth).toBeTruthy();
    if (auth?.kind !== "enum") throw new Error("expected an enum field");
    expect(auth.choices).toEqual(["api_token", "oauth"]);
    expect(auth.value).toBe("api_token"); // no `auth` block yet ⇒ shows the schema default
  });

  it("picking oauth writes auth.method into the document (creating the auth block)", () => {
    const doc = jiraDoc();
    const auth = fieldsFor(doc).find((f) => f.kind === "enum" && f.label === "auth.method");
    if (auth?.kind !== "enum") throw new Error("expected an enum field");
    auth.apply("oauth");
    expect(doc.getIn(["work_sources", 0, "jira", "auth", "method"])).toBe("oauth");
  });

  it("reflects an existing auth.method value", () => {
    const doc = parseDocument(`work_sources:
  - type: jira
    jira:
      base_url: https://x.atlassian.net
      project: P
      board: "1"
      auth: { method: oauth }
belt: []
`);
    const auth = fieldsFor(doc).find((f) => f.kind === "enum" && f.label === "auth.method");
    if (auth?.kind !== "enum") throw new Error("expected an enum field");
    expect(auth.value).toBe("oauth");
  });
});
