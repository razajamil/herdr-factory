// Doctor tab — machine-wide health (the same `baseGroups()` the `doctor` CLI command prints),
// rendered as green ✓ / red ✗ rows grouped by ownership (managed by herdr-factory vs you provide).
// The checks shell out to git/gh/claude/herdr and probe the server, so they run LAZILY: only when
// the tab receives focus (activate), and again on `r`. A generation counter drops the render if you
// leave the tab mid-run, so a slow check never paints onto another tab.
import { BoxRenderable, ScrollBoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import type { KeyEvent } from "@opentui/core";
import { baseGroups } from "../doctor.ts";
import { BORDER, theme } from "./theme.ts";
import type { TabView } from "./types.ts";

export function createDoctor(renderer: CliRenderer): TabView {
  const root = new BoxRenderable(renderer, { flexDirection: "column", width: "100%", height: "100%", backgroundColor: theme.bg, paddingLeft: 1, paddingRight: 1 });
  const banner = new TextRenderable(renderer, { content: "", fg: theme.text.secondary, height: 1, wrapMode: "none" });
  const list = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    width: "100%",
    scrollY: true,
    backgroundColor: theme.bg,
    border: true,
    borderStyle: BORDER,
    borderColor: theme.border.inactive,
    focusedBorderColor: theme.border.active,
    title: " doctor ",
    titleColor: theme.text.secondary,
    paddingLeft: 1,
    paddingRight: 1,
  });
  root.add(banner);
  root.add(list);

  // Bumped on every activate/deactivate/re-run: an async run whose token is stale won't paint.
  let gen = 0;

  function clearList(): void {
    for (const c of [...list.getChildren()]) {
      list.remove(c.id);
      c.destroy(); // cascades to a row box's children
    }
  }
  function addText(content: string, fg: string): void {
    list.add(new TextRenderable(renderer, { content, fg, width: "100%", height: 1, wrapMode: "none" }));
  }
  /** A check row: the ✓/✗ mark colored by status, then the name + detail. */
  function addCheck(mark: string, markFg: string, text: string, textFg: string): void {
    const row = new BoxRenderable(renderer, { flexDirection: "row", height: 1, width: "100%", backgroundColor: theme.bg });
    row.add(new TextRenderable(renderer, { content: `${mark} `, fg: markFg, height: 1, wrapMode: "none" }));
    row.add(new TextRenderable(renderer, { content: text, fg: textFg, height: 1, wrapMode: "none", flexGrow: 1 }));
    list.add(row);
  }

  async function run(): Promise<void> {
    const token = ++gen;
    banner.content = "running checks…";
    banner.fg = theme.text.secondary;
    let groups;
    try {
      groups = await baseGroups();
    } catch (e) {
      if (token !== gen) return;
      clearList();
      addText(`could not run checks: ${e instanceof Error ? e.message : String(e)}`, theme.status.bad);
      banner.content = "⚠ checks errored";
      banner.fg = theme.status.bad;
      return;
    }
    if (token !== gen) return; // left the tab (or re-triggered) mid-run — discard this result

    clearList();
    let failures = 0;
    groups.forEach((g, gi) => {
      if (gi > 0) addText("", theme.text.tertiary); // blank line between groups
      addText(`${g.title}:`, theme.text.secondary);
      for (const c of g.checks) {
        if (!c.ok) failures++;
        const line = c.detail ? `${c.name} — ${c.detail}` : c.name;
        addCheck(c.ok ? "✓" : "✗", c.ok ? theme.status.good : theme.status.bad, `  ${line}`, c.ok ? theme.text.primary : theme.status.bad);
      }
    });
    list.scrollTop = 0;
    banner.content = failures === 0 ? "● all checks passed · r: re-run" : `⚠ ${failures} check(s) failing · r: re-run`;
    banner.fg = failures === 0 ? theme.status.good : theme.status.warn;
  }

  list.onKeyDown = (key: KeyEvent) => {
    switch (key.name) {
      case "up":
        list.scrollTop = Math.max(0, list.scrollTop - 1);
        key.preventDefault();
        break;
      case "down":
        list.scrollTop = list.scrollTop + 1;
        key.preventDefault();
        break;
      case "r":
        void run();
        key.preventDefault();
        break;
    }
  };

  return {
    root,
    sectionCount: 1,
    focusSection(n: number) {
      if (n === 1) list.focus();
    },
    restoreFocus() {
      list.focus();
    },
    activate() {
      void run(); // run ONLY when the tab receives focus
    },
    deactivate() {
      gen++; // invalidate any in-flight run so it won't paint after we're gone
    },
  };
}
