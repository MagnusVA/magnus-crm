import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { expectedError } from "../lib/observability/errors";
import { baseProviderReviewState, refreshProviderPaymentReview } from "./match";

export function allocationChanged() {
  return expectedError("provider_payment.changed", "Someone else changed this payment. Reload to see the current state.");
}

const bindingAnchorArgs = {
  tenantId: v.id("tenants"),
  paymentRecordId: v.id("paymentRecords"),
};

type BindingAnchor = { tenantId: Id<"tenants">; paymentRecordId: Id<"paymentRecords">; through?: number };

function anchoredBindings(ctx: MutationCtx, { tenantId, paymentRecordId, through }: BindingAnchor) {
  return ctx.db.query("paymentProviderBindings")
    .withIndex("by_tenantId_kind_enabled_anchorPaymentRecordId", (q) => {
      const range = q.eq("tenantId", tenantId).eq("kind", "membership_deal").eq("enabled", true)
        .eq("binding.anchorPaymentRecordId", paymentRecordId);
      return through === undefined ? range : range.lte("_creationTime", through);
    });
}

async function disableAnchoredBindings(ctx: MutationCtx, args: BindingAnchor) {
  const bindingLimit = 100;
  const bindings = await anchoredBindings(ctx, args).take(bindingLimit + 1);
  for (const binding of bindings.slice(0, bindingLimit)) {
    await ctx.db.patch("paymentProviderBindings", binding._id, {
      enabled: false,
      disabledReason: "anchor_undone",
      version: binding.version + 1,
    });
  }
  if (bindings.length > bindingLimit) {
    // Limit the continuation to bindings that existed when the link was cleared.
    const through = args.through ?? (await anchoredBindings(ctx, args).order("desc").first())?._creationTime;
    if (through !== undefined) {
      await ctx.scheduler.runAfter(0, internal.payments.allocation.continueDisablingAnchoredBindings, {
        ...args, through,
      });
    }
  }
}

export const continueDisablingAnchoredBindings = internalMutation({
  args: { ...bindingAnchorArgs, through: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await disableAnchoredBindings(ctx, args);
    return null;
  },
});

/** Clear the active pointer. The excluded CRM row keeps its provider provenance. */
export async function clearActiveAllocation(
  ctx: MutationCtx,
  record: Doc<"paymentRecords">,
) {
  if (!record.providerPaymentId) return;
  const payment = await ctx.db.get("providerPayments", record.providerPaymentId);
  if (payment?.tenantId !== record.tenantId || payment.paymentRecordId !== record._id) return;

  await disableAnchoredBindings(ctx, { tenantId: record.tenantId, paymentRecordId: record._id });
  const connection = await ctx.db.get("tenantPaymentConnections", payment.connectionId);
  await ctx.db.patch("providerPayments", payment._id, {
    paymentRecordId: undefined,
    allocationRevision: payment.allocationRevision + 1,
    opportunityId: undefined,
    leadId: undefined,
    matchMethod: undefined,
    reviewState: baseProviderReviewState(payment, connection?.autoImportAfter ?? 0),
    reviewReason: undefined,
    candidateLeadId: undefined,
    candidateOpportunityId: undefined,
    matchedAt: undefined,
    dismissReason: undefined,
    resolvedAt: undefined,
    resolvedByUserId: undefined,
    adverseReviewAt: undefined,
  });
  await refreshProviderPaymentReview(ctx, payment._id);
}
