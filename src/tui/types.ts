import type { Renderable } from "@opentui/core";

/** Shell-provided modal helpers passed into views. */
export type ConfirmFn = (message: string) => Promise<boolean>;
export type ChooseFn = (title: string, options: { label: string; value: string }[]) => Promise<string | null>;

/** A top-level tab (lazygit-style navigation). The shell (index.ts) shows one view at a time and
 *  owns a three-level focus hierarchy: top level (the tab bar) → a numbered section → editing a
 *  text field. `Tab`/`Shift+Tab` switch views; number keys jump to a section; arrows navigate
 *  inside the focused section; `Esc` pops to the top level from any depth. Each view remembers the
 *  section it was last in (`restoreFocus`), and the shell remembers whether each tab was left at
 *  the top level, so switching tabs returns you to where you were for the session. */
export interface TabView {
  /** The container renderable mounted into the shell's content area. */
  readonly root: Renderable;
  /** How many numbered sections this view exposes (for the footer + number-key jumps). */
  readonly sectionCount: number;
  /** Focus section `n` (1-based); no-op if out of range. Records it as this view's last section. */
  focusSection(n: number): void;
  /** Re-focus the section this view was last in (default: section 1). Used when returning to a tab. */
  restoreFocus(): void;
  /** Called when this tab becomes visible. */
  activate(): void;
  /** Called when leaving this tab (stop timers, etc.). */
  deactivate(): void;
  /** Ctrl-S handler; present only on editable views. */
  save?(): void;
  /** Move to the adjacent field while editing a text field (↑/↓). */
  editMove?(dir: -1 | 1): void;
}
