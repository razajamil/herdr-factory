// Shared renderable factories. Two selection concerns live here so every view inherits them:
//  • Native text selection is OFF by default. This is a navigation-first, click-to-move TUI: a click
//    that nudges even a cell starts an opentui drag-selection, and with no `selectionBg` set opentui
//    falls back to a near-black highlight that renders the text unreadable (the dark box over the
//    config rows). Disabling selection on plain text kills that at the source.
//  • The surfaces that genuinely want selection — text inputs (select-to-replace) and the read-only
//    info modal (copy an error / a path) — opt back in with readable colors via `input()` / the
//    `selectable` override, since opentui's default selection background is otherwise unreadable.
import { BoxRenderable, InputRenderable, TextRenderable, type CliRenderer, type Renderable } from "@opentui/core";
import { theme } from "./theme.ts";

type TextOpts = ConstructorParameters<typeof TextRenderable>[1];
type InputOpts = ConstructorParameters<typeof InputRenderable>[1];

/** Readable colors for any renderable that keeps native selection on (inputs, info lines). */
export const SELECTION = { selectionBg: theme.selection.bg, selectionFg: theme.text.primary } as const;

/** A text line with native selection disabled (the app-wide default). Pass `selectable: true` plus
 *  `...SELECTION` to opt a line back into readable selection. */
export function text(renderer: CliRenderer, opts: TextOpts): TextRenderable {
  return new TextRenderable(renderer, { selectable: false, ...opts });
}

/** A text input that keeps selection (needed to select-to-replace) but with readable colors. */
export function input(renderer: CliRenderer, opts: InputOpts): InputRenderable {
  return new InputRenderable(renderer, { ...SELECTION, ...opts });
}

/** Add a subtle hover tint to a row/control. Requires `enableMouseMovement: true` on the renderer
 *  (otherwise over/out never fire). The tint is a background fill only, so it sits under the active
 *  highlight (a gutter marker + accent text) rather than replacing it. `restBg` is the row's resting
 *  background to revert to on mouse-out. Box and Text expose different background setters, so branch.
 *  `enabled` lets a caller gate hover per-event (e.g. only rows that are currently focusable). */
export function hoverable(r: Renderable, restBg: string = theme.bg, enabled: () => boolean = () => true): void {
  const set = (color: string) => {
    if (r instanceof TextRenderable) r.bg = color;
    else if (r instanceof BoxRenderable) r.backgroundColor = color;
  };
  r.onMouseOver = () => { if (enabled()) set(theme.hoverBg); };
  r.onMouseOut = () => set(restBg);
}
