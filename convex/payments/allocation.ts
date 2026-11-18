import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "../_generated/server";
import { expectedError } from "../lib/observability/errors";
import { adverseReviewRequired } from "./intake";
import { baseProviderReviewState, refreshProviderPaymentReview } from "./match";
import { payerDetailsDeadline } from "./payerRetention";

/** Rows citing one provider payment that a write reads before allocating it. */
export const ALLOCATION_HISTORY_LIMIT = 40;
/** Deals a person took one provider payment off as a wrong match. */
export const EXCLUDED_OPPORTUNITY_LIMIT = 20;

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

function brokenAllocation(payment: Doc<"providerPayments">, reason: string) {
  return new Error(`Provider payment ${payment._id} has a broken allocation: ${reason}`);
}

/**
 * The row that counts for `payment` now, read through the pointer; null when
 * unset. Re-reads the payment, and throws on a broken reciprocal: a missing or
 * other-tenant row, a row that cites another payment or doesn't count, or a
 * review state other than linked or recorded.
 */
export async function readActiveAllocation(
  ctx: QueryCtx | MutationCtx,
  payment: Doc<"providerPayments">,
): Promise<Doc<"paymentRecords"> | null> {
  const current = await ctx.db.get("providerPayments", payment._id);
  if (!current) throw new Error(`Provider payment ${payment._id} not found`);
  if (current.paymentRecordId === undefined) return null;
  const record = await ctx.db.get("paymentRecords", current.paymentRecordId);
  if (!record || record.tenantId !== current.tenantId) throw brokenAllocation(current, "row missing");
  if (record.providerPaymentId !== current._id) throw brokenAllocation(current, "row cites another payment");
  if (record.status === "disputed") throw brokenAllocation(current, "row does not count");
  if (current.reviewState !== "linked" && current.reviewState !== "recorded") {
    throw brokenAllocation(current, `review state ${current.reviewState}`);
  }
  return record;
}

/**
 * Point `payment` at `record` and `record` back at it, in this mutation: the
 * payment's pointer, `allocationRevision + 1`, person, deal, match method,
 * review state and resolution (with the adverse review and payer-detail
 * deadline a Billing link sets), the deal taken off `excludedOpportunityIds`;
 * the row's `providerPaymentId` and `providerPaidAt`. Re-reads both rows and
 * every row citing the payment. Throws `provider_payment.changed` when the
 * revision moved. Emits no event and touches no aggregate: the row's cash,
 * status and deal don't change.
 */
export async function setActiveAllocation(
  ctx: MutationCtx,
  args: {
    payment: Doc<"providerPayments">;
    record: Doc<"paymentRecords">;
    expectedAllocationRevision: number;
    reviewState: "recorded" | "linked";
    matchMethod: "membership_binding" | "email_one_open_deal" | "person";
    actorUserId: Id<"users">;
    now: number;
  },
): Promise<void> {
  const payment = await ctx.db.get("providerPayments", args.payment._id);
  const record = await ctx.db.get("paymentRecords", args.record._id);
  if (!payment) throw expectedError("provider_payment.not_found", "Provider payment not found.");
  if (!record || record.tenantId !== payment.tenantId) {
    throw expectedError("provider_payment.record_not_found", "CRM payment not found.");
  }
  if (payment.allocationRevision !== args.expectedAllocationRevision) throw allocationChanged();
  if (payment.paymentRecordId !== undefined || payment.reviewState === "linked" || payment.reviewState === "recorded") {
    throw expectedError("provider_payment.already_allocated", "This provider payment has an active allocation.");
  }
  if (payment.reviewState === "dismissed") throw expectedError("provider_payment.dismissed", "Reopen this provider payment first.");
  if (payment.status !== "paid") throw expectedError("provider_payment.not_paid", "The provider has not marked this payment paid.");
  if (record.status === "disputed") throw expectedError("provider_payment.record_disputed", "This CRM payment is disputed.");
  if (record.providerPaymentId !== undefined && record.providerPaymentId !== payment._id) {
    throw expectedError("provider_payment.record_already_linked", "This CRM payment already has provider evidence.");
  }

  // The pointer is authoritative; fail closed if another counting row cites
  // this payment, or if there are too many rows to tell.
  const provenance = await ctx.db.query("paymentRecords")
    .withIndex("by_tenantId_and_providerPaymentId", (q) =>
      q.eq("tenantId", payment.tenantId).eq("providerPaymentId", payment._id))
    .take(ALLOCATION_HISTORY_LIMIT + 1);
  if (provenance.some((row) => row._id !== record._id && row.status !== "disputed")) {
    throw expectedError("provider_payment.already_allocated", "A counting CRM payment already has this evidence.");
  }
  if (provenance.length > ALLOCATION_HISTORY_LIMIT) {
    throw expectedError("provider_payment.allocation_check_incomplete", "Too many previous links to verify.");
  }

  const deal = record.opportunityId && await ctx.db.get("opportunities", record.opportunityId);
  const lead = deal && await ctx.db.get("leads", deal.leadId);
  if (!deal || deal.tenantId !== payment.tenantId || !lead || lead.tenantId !== payment.tenantId || lead.status === "merged") {
    throw expectedError("provider_payment.invalid_record_target", "The CRM payment needs a deal with a current person.");
  }

  await ctx.db.patch("paymentRecords", record._id, {
    providerPaymentId: payment._id,
    providerPaidAt: payment.paidAt,
  });
  const reviewAdverse = adverseReviewRequired(payment);
  const excluded = payment.excludedOpportunityIds?.filter((id) => id !== deal._id);
  await ctx.db.patch("providerPayments", payment._id, {
    paymentRecordId: record._id,
    allocationRevision: payment.allocationRevision + 1,
    adverseReviewAt: reviewAdverse ? args.now : undefined,
    adverseReviewRevision: payment.adverseReviewRevision + (reviewAdverse ? 1 : 0),
    opportunityId: deal._id,
    leadId: lead._id,
    matchMethod: args.matchMethod,
    reviewState: args.reviewState,
    reviewReason: undefined,
    resolvedAt: args.now,
    payerDetailsExpireAt: payerDetailsDeadline(payment, "needs_person", args.now),
    resolvedByUserId: args.actorUserId,
    ...(payment.excludedOpportunityIds === undefined
      ? {}
      : { excludedOpportunityIds: excluded?.length ? excluded : undefined }),
  });
}

/**
 * Clear the active pointer. The excluded CRM row keeps its provider
 * provenance. `vetoOpportunityId` (a wrong match) adds that deal to the
 * payment's `excludedOpportunityIds` in the same write, before the review is
 * refreshed; at most 20, and a veto past that throws.
 */
export async function clearActiveAllocation(
  ctx: MutationCtx,
  record: Doc<"paymentRecords">,
  options: { vetoOpportunityId?: Id<"opportunities"> } = {},
) {
  const { vetoOpportunityId } = options;
  const payment = record.providerPaymentId && await ctx.db.get("providerPayments", record.providerPaymentId);
  if (!payment || payment.tenantId !== record.tenantId || payment.paymentRecordId !== record._id) {
    // Nothing to clear. A veto has nowhere to go, which only a caller bug reaches.
    if (vetoOpportunityId) throw new Error(`Payment ${record._id} is not the active allocation; cannot record a veto`);
    return;
  }

  let excludedOpportunityIds = payment.excludedOpportunityIds;
  if (vetoOpportunityId) {
    const vetoed = await ctx.db.get("opportunities", vetoOpportunityId);
    if (vetoed?.tenantId !== payment.tenantId) throw new Error(`Deal ${vetoOpportunityId} is not in this tenant`);
    const current = payment.excludedOpportunityIds ?? [];
    if (!current.includes(vetoOpportunityId)) {
      if (current.length >= EXCLUDED_OPPORTUNITY_LIMIT) {
        throw expectedError("provider_payment.veto_limit", "This payment has been taken off too many deals. Dismiss it instead.");
      }
      excludedOpportunityIds = [...current, vetoOpportunityId];
    }
  }

  await disableAnchoredBindings(ctx, { tenantId: record.tenantId, paymentRecordId: record._id });
  const connection = await ctx.db.get("tenantPaymentConnections", payment.connectionId);
  await ctx.db.patch("providerPayments", payment._id, {
    ...(vetoOpportunityId ? { excludedOpportunityIds } : {}),
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
