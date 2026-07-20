// The PRODUCT-CAPABILITY registry: one entry per typed product, carrying the ENGINE MACHINERY a
// product switches on — capability-scoped prompt tokens, a durable outbox, PR adoption identity, the
// produce→WorkState effect, and (crucially) the terminal WATCH capability that owns the resolver
// agent, which is NOT a belt step. This is the second registry the redesign needs: a steps-only
// model would leave the resolver as a hardcoded second state machine.
import type { Phase, PrState, ProductType, WorkState } from "../types.ts";

/** The resolver agent a watch capability owns. It is not a StepDescriptor: it lives outside
 *  belt.steps, reuses the PR producer's pane, and is spawned agent-agnostically (mirroring
 *  dispatchToLayout). Its wake prompt is a tokenized, source-overridable library entry. */
export interface WatchResolverSpec {
  readonly wakePrompt: { readonly slug: string; readonly perSourceOverride: boolean; readonly tokens: readonly string[] };
  readonly reusesPaneOf: ProductType;
  readonly spawn: "agent-agnostic";
}

/** A terminal watch attached to a product: poll the product's external state, wake a resolver on
 *  fresh actionable state, and hold a max_active_workspaces slot ONLY while resolving
 *  (idleHoldsSlot=false). `terminalStates` maps an external state to an engine action. */
export interface WatchSpec {
  readonly subPhase: Phase;
  readonly signalSource: "github_review_signature";
  readonly terminalStates: Readonly<Record<PrState, string>>;
  readonly idleHoldsSlot: boolean;
  readonly resolver: WatchResolverSpec;
}

/** The mid-pipeline PR identity facet (today's opensPr): discover by branch then adopt by number,
 *  ignore a stale CLOSED PR from a reused branch, and treat an observed terminal state (MERGED) as
 *  step completion. Independent of the terminal watch. */
export interface AdoptionSpec {
  readonly discover: readonly ("by_branch" | "by_number")[];
  readonly observedCompletion: readonly PrState[];
  readonly perAttemptBranchUid: boolean;
}

export interface ProductCapability {
  readonly product: ProductType;
  /** Capability-scoped tokens injected into a step's prompt only when the step touches this product
   *  (universal tokens like @@KEY@@/@@WORK_DOC@@ stay always-injected in step.ts). */
  readonly tokens?: readonly string[];
  /** Enables an existing durable outbox drained by the reconciler (evidence S3 upload). */
  readonly outbox?: "evidence_uploads";
  /** Source lifecycle transition emitted when this product is produced (forward-only). */
  readonly effectOnProduce?: { readonly to: WorkState };
  readonly adoption?: AdoptionSpec;
  readonly watch?: WatchSpec;
  /** SignalDescriptor names this product contributes to the agent-facing surface. */
  readonly signals?: readonly string[];
}

export const PRODUCT_CAPABILITIES: readonly ProductCapability[] = [
  { product: "work_spec" }, // satisfied by the source's materialize; @@WORK_DOC@@ is universal
  { product: "work_raw", tokens: ["@@WORK_RAW@@"] },
  { product: "commits" }, // makes the heartbeat guard meaningful; no tokens of its own
  { product: "handoff" }, // @@HANDOFF_IN@@/@@HANDOFF_OUT@@ are universal (mandatory product)
  { product: "human_reply" }, // waiting_for_human park/resume (generic; human_questions table)
  { product: "bounce_feedback" }, // bounce tokens are gated on controls.bounce, not the consume
  { product: "close_reference", tokens: ["@@CLOSE_REFERENCE@@"] },
  {
    product: "evidence",
    tokens: ["@@EVIDENCE_DIR@@", "@@EVIDENCE_UPLOAD_CMD@@", "@@CAPTURE_ATTEMPT_CMD@@"],
    outbox: "evidence_uploads",
    signals: ["capture-attempt", "evidence-upload"],
  },
  {
    product: "pull_request",
    // @@PR_NUMBER@@ is the resolver wake-prompt's (not a step-prompt token — kept out of the
    // step-prompt catalog in contract.ts); @@PR_TEMPLATE@@ is the PR step's, carrying the target
    // repo's own pull-request template so the PR follows the team's shape.
    tokens: ["@@PR_NUMBER@@", "@@PR_TEMPLATE@@"],
    effectOnProduce: { to: "in_review" },
    adoption: { discover: ["by_branch", "by_number"], observedCompletion: ["MERGED"], perAttemptBranchUid: true },
    watch: {
      subPhase: "reviewing",
      signalSource: "github_review_signature",
      terminalStates: { OPEN: "watch", MERGED: "teardown:merged", CLOSED: "park:pr_closed" },
      idleHoldsSlot: false,
      resolver: {
        wakePrompt: { slug: "resolver", perSourceOverride: true, tokens: ["@@KEY@@", "@@PR_NUMBER@@"] },
        reusesPaneOf: "pull_request",
        spawn: "agent-agnostic",
      },
    },
  },
];

export function productCapabilityFor(product: ProductType): ProductCapability {
  const c = PRODUCT_CAPABILITIES.find((p) => p.product === product);
  if (!c) throw new Error(`no product capability registered for "${product}"`); // unreachable: ProductType is closed
  return c;
}
