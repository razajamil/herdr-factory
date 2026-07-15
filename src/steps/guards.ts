// Shared guard builders for the shipped step descriptors. A LEAF module (imports only the GuardSpec
// type) so descriptors can import these without creating a cycle through registry.ts — registry.ts
// imports the descriptors, so it can't also be the module that defines what the descriptors need at
// import-eval time (that was a temporal-dead-zone crash on load).
//
// The union of guards with autoRescueOnDone===true is STEP_WATCHDOG_ATTENTION (a genuine step-done
// un-parks a run a watchdog parked); bounce_limit / pr_closed / source_item_stale / human / config
// parks are not here.
import type { GuardSpec } from "../types.ts";

export const BUDGET_GUARD: GuardSpec = { kind: "budget", escalationReason: "step_budget", autoRescueOnDone: true };
export const HEARTBEAT_GUARD: GuardSpec = { kind: "heartbeat", escalationReason: "step_stalled", autoRescueOnDone: true, requiresProduct: "commits" };
export const LAYOUT_WAIT_GUARD: GuardSpec = { kind: "layout_wait", escalationReason: "layout_wait_timeout", autoRescueOnDone: true, attachWhen: "layoutTarget" };
export const CAPTURE_CAP_GUARD: GuardSpec = { kind: "capture_cap", escalationReason: "capture_limit", autoRescueOnDone: true, reset: "forward_entry", cumulative: false, requiresProduct: "evidence" };
// A machine-global exclusive resource the step's agent holds while driving the app (the capture
// mutex). NOT a watchdog (never parks/auto-rescues) and not a counter — its @@CAPTURE_LOCK_*_CMD@@
// tokens are injected only for a step that declares it, and the engine backstop-releases it on step
// exit (owner = the run's key) so a forgotten release frees immediately instead of waiting its TTL.
export const CAPTURE_LOCK_GUARD: GuardSpec = { kind: "exclusive_resource", resourceName: "capture", escalationReason: "capture_lock", autoRescueOnDone: false };
