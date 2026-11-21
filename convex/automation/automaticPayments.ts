import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { log } from "../lib/observability/log";
import { applyProviderPayment, previewProviderApply } from "../payments/apply";
import { assertAutomaticAllowed, WHOP_FRESH_MS } from "./breaker";
import { rederivePayment, scheduleEvaluation, stopDecision } from "./decisions";
import { isPaymentKind } from "./proposals";
import { effectiveKindMode } from "./settings";

// The automatic payment executor (phase 3 contract §2.13). A Whop payment the
// owner's certified rule would record is written here, with no person: a
// first win after a 15-minute grace, a later payment on a won deal at once.
// The scheduled wake-up and the repair sweep only say "look now". Every
// check runs again inside this one mutation, before anything is written.

export { AUTOMATIC_WIN_GRACE_MS } from "./decisions";
/** Whop must have swept within this window for money to be written. */
export const WHOP_FRESH_FOR_MONEY_MS = WHOP_FRESH_MS;
/** How long a decision waits for Whop to catch up before it looks again. */
export const WHOP_STALE_RETRY_MS = 10 * 60_000;

type Decision = Doc<"resultAutomationDecisions">;
export type AutomaticPaymentOutcome =
  | "applied" // the payment was recorded
  | "not_due" // not ready, not automatic, not a payment, or not due yet: nothing to do
  | "waiting" // Whop is stale: the decision stays ready and looks again
  | "asked" // the gate refused: the decision is now an ask a person sees
  | "stopped" // automation is off for the kind: the decision is retired
  | "superseded"; // the facts changed: a fresh evaluation replaces it

export const outcomeValidator = v.union(
  v.literal("applied"), v.literal("not_due"), v.literal("waiting"), v.literal("asked"),
  v.literal("stopped"), v.literal("superseded"),
);

const executeRef = makeFunctionReference<"mutation", { decisionId: Id<"resultAutomationDecisions"> }>(
  "automation/automaticPayments:executeAutomaticPayment",
);

/**
 * The gate refused: no automatic write. Under a kind that is off the row is
 * retired; otherwise it stays ready as an ask a person confirms (the Billing
 * or meeting card), and a fresh evaluation is asked for.
 */
export async function dropToAsk(
  ctx: MutationCtx, tenant: Doc<"tenants"> | null, decision: Decision,
  gate: "out_of_scope" | "mapping_held" | null,
): Promise<"asked" | "stopped"> {
  const kind = decision.kind;
  if (kind === "paid_on_call_alert" || !tenant || effectiveKindMode(tenant, kind) === "off") {
    await stopDecision(ctx, decision._id, null,
      !tenant || tenant.status !== "active" || !tenant.resultAutomation?.enabled ? "paused" : "kind_lowered");
    return "stopped";
  }
  await ctx.db.patch("resultAutomationDecisions", decision._id, {
    mode: "ask",
    dueAt: undefined,
    ...(gate && !decision.gates.includes(gate) && { wouldWrite: false, gates: [...decision.gates, gate].sort() }),
  });
  return "asked";
}

async function supersedeAndReevaluate(ctx: MutationCtx, decision: Decision): Promise<"superseded"> {
  await stopDecision(ctx, decision._id, null, "input_changed");
  if (decision.providerPaymentId) await scheduleEvaluation(ctx, decision.providerPaymentId, "sweep");
  return "superseded";
}

/**
 * One automatic payment write, in the caller's mutation. In order:
 *  1. the decision is ready, automatic, a payment kind, and due;
 *  2. assertAutomaticAllowed: kind automatic, certificate current, no breaker,
 *     same policy and activation, the mapping in scope and not held, no
 *     unanswered "not my sale", Whop fresh (stale waits; any other refusal
 *     drops the decision to an ask);
 *  3. the facts re-derived now give the stored inputKey (else superseded);
 *  4. the deal's humanResultRevision is the decision's (else superseded);
 *  5. the apply preview's fingerprint is taken in this mutation, and
 *     applyProviderPayment re-checks every gate and the decision once more
 *     before it writes, with no approver.
 */
export async function runAutomaticPayment(
  ctx: MutationCtx, decisionId: Id<"resultAutomationDecisions">, now: number,
): Promise<AutomaticPaymentOutcome> {
  const decision = await ctx.db.get("resultAutomationDecisions", decisionId);
  if (!decision || decision.state !== "ready" || decision.mode !== "automatic" || !isPaymentKind(decision.kind) ||
      decision.dueAt === undefined || now < decision.dueAt || !decision.providerPaymentId || !decision.opportunityId) {
    return "not_due";
  }
  const kind = decision.kind;
  const tenant = await ctx.db.get("tenants", decision.tenantId);

  const allowed = await assertAutomaticAllowed(ctx, { tenantId: decision.tenantId, kind, decision }, now);
  if (!allowed.ok) {
    if (allowed.gate === "whop_stale") {
      const dueAt = now + WHOP_STALE_RETRY_MS;
      await ctx.db.patch("resultAutomationDecisions", decisionId, { dueAt });
      await ctx.scheduler.runAt(dueAt, executeRef, { decisionId });
      return "waiting";
    }
    const gate = allowed.gate === "out_of_scope" || allowed.gate === "mapping_held" ? allowed.gate : null;
    return await dropToAsk(ctx, tenant, decision, gate);
  }

  if (!(await rederivePayment(ctx, decision, now)).same) return await supersedeAndReevaluate(ctx, decision);
  const deal = await ctx.db.get("opportunities", decision.opportunityId);
  if (!deal || deal.tenantId !== decision.tenantId ||
      (deal.humanResultRevision ?? 0) !== decision.humanResultRevision) {
    return await supersedeAndReevaluate(ctx, decision);
  }

  const target = {
    tenantId: decision.tenantId, providerPaymentId: decision.providerPaymentId, opportunityId: deal._id, now,
  };
  const preview = await previewProviderApply(ctx, target);
  if (!preview.ok || preview.alreadyApplied || preview.kind !== kind) return await supersedeAndReevaluate(ctx, decision);
  const applied = await applyProviderPayment(ctx, {
    ...target,
    decisionId,
    expectedFingerprint: preview.fingerprint,
    expectedAllocationRevision: preview.allocationRevision,
    via: "automatic",
    certificateSampleId: allowed.sampleId,
  });
  if (!applied.ok || applied.alreadyApplied) {
    log.warn("automation.automatic_payment_refused", {
      tenantId: decision.tenantId, decisionId, code: applied.ok ? "already_applied" : applied.code,
    });
    return await supersedeAndReevaluate(ctx, decision);
  }
  return "applied";
}

/** Scheduled at the decision's dueAt by evaluateSubject, and by the repair sweep. */
export const executeAutomaticPayment = internalMutation({
  args: { decisionId: v.id("resultAutomationDecisions") },
  returns: outcomeValidator,
  handler: async (ctx, { decisionId }) => await runAutomaticPayment(ctx, decisionId, Date.now()),
});
