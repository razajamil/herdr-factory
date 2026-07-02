// Colors for the TUI. The base palette is lifted from `lighter`
// (https://github.com/razajamil/lighter) — a calm, light, WCAG-AA colorscheme on a #f7f7f7 ground —
// and mirrors its role names (fg/comment/faint for text levels, border vs emphasis for
// inactive/active, line for fills/selection, and the diagnostic hues).
//
// opentui has no central theme system: colors are passed per-component. But most components expose
// built-in `focused*` / `selected*` variants (focusedBorderColor, focused/selected background+text),
// so the active↔inactive swap is handled natively wherever a component owns its focus. For the
// composite cases — a panel border that tracks a child widget's focus, or the active section — we
// swap the token by hand (see setActiveSection in config-editor.ts). The structured tokens below are
// the single source we feed into both paths.

const palette = {
  bg: "#f7f7f7", // canvas
  fg: "#000000", // primary text
  line: "#e2eeee", // subtle fill / selection / chrome bars
  tint: "#dbe3f2", // light-blue focus fill (derived from emphasis over bg)
  border: "#9e9e9e", // inactive borders
  comment: "#787878", // secondary text
  faint: "#a9a9a9", // tertiary text
  emphasis: "#325cc0", // accent / active / titles
  success: "#3e8024",
  warning: "#a16400",
  danger: "#d13e23",
  info: "#0075c4",
} as const;

export const theme = {
  /** Canvas background (also set on the renderer so the whole TUI reads as light). */
  bg: palette.bg,
  /** Header / footer / statusline fill. */
  barBg: palette.line,
  /** Tab bar fill when it holds the top-level focus. */
  barFocusBg: palette.tint,

  /** Panel / section borders — swap active⇄inactive on focus. */
  border: {
    active: palette.emphasis,
    inactive: palette.border,
  },

  /** Text hierarchy, three levels. */
  text: {
    primary: palette.fg, // content
    secondary: palette.comment, // labels
    tertiary: palette.faint, // hints / de-emphasized
  },

  /** Text that reflects focus state — titles, tab labels, a highlighted row/field. */
  focusText: {
    focused: palette.emphasis,
    unfocused: palette.comment,
  },

  /** Selected row in a list. */
  selection: {
    bg: palette.line,
    fg: palette.emphasis,
  },

  /** Text input field states. */
  input: {
    bg: palette.line, // resting field chip
    fg: palette.fg,
    placeholder: palette.faint,
    focusBg: palette.tint, // focused / highlighted field
    focusFg: palette.fg,
    error: palette.danger,
  },

  /** Semantic status — kept separate from the accent. */
  status: {
    good: palette.success,
    warn: palette.warning,
    bad: palette.danger,
    info: palette.info,
  },

  /** The one accent (emphasis blue). */
  accent: palette.emphasis,
} as const;

/** Default border style for panels. */
export const BORDER = "rounded" as const;
