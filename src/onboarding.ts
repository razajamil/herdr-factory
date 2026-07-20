// The onboarding "pointer chain". A new operator walks a fixed sequence of first-run stages, and
// each stage ends by printing what to do NEXT — so the aha path is self-guiding and you're never
// left guessing where it continues:
//
//   install.sh → `install` (supervisor) → `init` (configure a repo) → `doctor` (verify)
//              → `run --follow` (the first live run) → `start` (keep it running in the background)
//              → the TUI / `status` (watch it work)
//
// Two links already build their own pointer inline: `init` ends its source-specific next-steps on
// the `doctor` link (src/init.ts), and `run` ends its non-follow summary on the `start` link
// (src/cli/run.ts). The remaining links route through the pure builders below, so the chain's
// wording lives in one place and stays consistent (and unit-testable) across the CLI and install.sh.
// install.sh needs no builder of its own: its epilogue runs `herdr-factory doctor`, whose own
// pointer (afterDoctorHint) is the forward link — "resolve the ✗ tools" on a fresh box, "point it at
// a repo" once the machine is ready.
//
// Pure — no IO. Each returns the pointer text a stage prints after its own success output.

/** After the supervisor is installed (the standalone `install` command): the next stage is
 *  configuring a repo, which you scaffold from inside your project checkout with `init`. */
export function afterInstallHint(): string {
  return "Next: configure your first repo — from inside your project checkout, run `herdr-factory init`.";
}

/** After `start` loads the supervisor: the factory now runs on its own — point at how to watch it. */
export function afterStartHint(): string {
  return "Next: watch it work — run `herdr-factory` for the TUI dashboard, or `herdr-factory --repo <name> status`.";
}

/** After a `doctor` run. The forward pointer depends on where the operator is in the chain:
 *   • any ✗            → don't push forward; resolve them and re-run doctor.
 *   • all ✓, a repo, shallow → verify the live setup with a deep repo doctor first.
 *   • all ✓, a repo, deep    → the repo is healthy; take the first live run (`run --follow`).
 *   • all ✓, no repo         → the machine is healthy; point it at a repo with `init`, then a deep repo doctor.
 *  `repo` is the --repo the doctor ran against (undefined ⇒ base/machine-wide checks only). */
export function afterDoctorHint(opts: { repo?: string; deep: boolean; failed: boolean }): string {
  if (opts.failed) return "Resolve the ✗ items above, then re-run `herdr-factory doctor`.";
  if (!opts.repo) {
    return "Next: point it at a repo — run `herdr-factory init` from inside your project checkout, then `herdr-factory --repo <name> doctor --deep`.";
  }
  if (!opts.deep) {
    return `Next: verify the live setup — \`herdr-factory --repo ${opts.repo} doctor --deep\` (gh auth · work-source health · evidence publisher).`;
  }
  return `Next: take your first run — \`herdr-factory --repo ${opts.repo} run --follow\`.`;
}
