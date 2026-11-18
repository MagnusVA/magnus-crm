import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type QueryCtx } from "../_generated/server";
import { expectedError } from "../lib/observability/errors";
import { isSideDeal, isSideDealPayment } from "../lib/sideDeals";
import { describeDealState, isWonDeal } from "../opportunities/dealGuards";
import { sha256Hex, stableJson } from "../lib/stableHash";
import { excludePaymentCore, findExclusionReplay } from "../payments/exclude";
import { requireTenantUser } from "../requireTenantUser";

function latestCorrection(ctx: QueryCtx, payment: Doc<"paymentRecords">) {
  return ctx.db.query("paymentCorrections")
    .withIndex("by_tenantId_and_paymentRecordId_and_createdAt", (q) =>
      q.eq("tenantId", payment.tenantId).eq("paymentRecordId", payment._id))
    .order("desc")
    .first();
}

function statusVersion(payment: Doc<"paymentRecords">, correctionId: Id<"paymentCorrections"> | null) {
  // The receipt distinguishes restores and voids even in the same millisecond.
  return stableJson([payment.status, payment.statusChangedAt ?? null, correctionId]);
}

function voidRequestKey(paymentId: Id<"paymentRecords">, version: string) {
  return sha256Hex(stableJson(["exclude", paymentId, "side_deal_void", version]));
}

function staleVoid() {
  return expectedError("payment.stale_preview", "The payment changed. Reload and try again.");
}

export const getVoidStatusVersion = query({
  args: { paymentId: v.id("paymentRecords") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { paymentId }) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    const payment = await ctx.db.get("paymentRecords", paymentId);
    if (payment?.tenantId !== tenantId || payment.status === "disputed" || !payment.opportunityId) return null;
    const deal = await ctx.db.get("opportunities", payment.opportunityId);
    if (deal?.tenantId !== tenantId || !isSideDealPayment(payment, deal) || !isWonDeal(deal)) return null;
    const latest = await latestCorrection(ctx, payment);
    return statusVersion(payment, latest?._id ?? null);
  },
});

/**
 * Voids a side deal's payment through the shared exclusion
 * (convex/payments/exclude.ts, cause `voided`). Another payment that still
 * counts keeps the deal won; with none, the deal closes lost as
 * `payment_excluded`. The typed reason is kept on the `payment.voided` event.
 */
export const voidPayment = mutation({
  args: {
    paymentId: v.id("paymentRecords"),
    reason: v.string(),
    expectedStatusVersion: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { paymentId, reason, expectedStatusVersion }) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      throw new Error("Void reason is required.");
    }

    const payment = await ctx.db.get("paymentRecords", paymentId);
    if (!payment || payment.tenantId !== tenantId) {
      throw new Error("Payment not found.");
    }
    const pinnedKey = expectedStatusVersion === undefined
      ? undefined
      : await voidRequestKey(paymentId, expectedStatusVersion);
    if (pinnedKey !== undefined && await findExclusionReplay(ctx, tenantId, paymentId, pinnedKey)) return null;

    if (payment.status === "disputed") {
      throw new Error("Already voided.");
    }
    if (payment.status !== "recorded" && payment.status !== "verified") {
      throw new Error("Only active side-deal payments can be voided here.");
    }
    if (!payment.opportunityId) {
      throw new Error("Only opportunity payments can be voided here.");
    }

    const opportunity = await ctx.db.get("opportunities", payment.opportunityId);
    if (
      !opportunity ||
      opportunity.tenantId !== tenantId ||
      !isSideDeal(opportunity) ||
      !isSideDealPayment(payment, opportunity)
    ) {
      throw new Error("Only side-deal payments can be voided via this mutation.");
    }
    if (!isWonDeal(opportunity)) {
      throw new Error(
        `Cannot void a side-deal payment while the deal is "${describeDealState(opportunity)}".`,
      );
    }

    const latest = await latestCorrection(ctx, payment);
    const currentVersion = statusVersion(payment, latest?._id ?? null);
    // Older clients can void for the first time. After a correction, only a
    // request pinned to the current version can take the payment out again.
    if (expectedStatusVersion === undefined ? latest !== null : expectedStatusVersion !== currentVersion) {
      throw staleVoid();
    }

    const result = await excludePaymentCore(
      ctx,
      { userId, tenantId, role },
      { paymentRecordId: paymentId, cause: "voided", level: "reviewed", voidReason: trimmedReason },
      { sideDealRequestKey: pinnedKey ?? await voidRequestKey(paymentId, currentVersion) },
    );
    if (!result.ok) {
      throw expectedError(`payment.${result.code}`, "This payment can't be voided right now. Reload and try again.");
    }
    return null;
  },
});
