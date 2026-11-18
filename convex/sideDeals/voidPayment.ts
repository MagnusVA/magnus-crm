import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { expectedError } from "../lib/observability/errors";
import { isSideDeal, isSideDealPayment } from "../lib/sideDeals";
import { describeDealState, isWonDeal } from "../opportunities/dealGuards";
import { excludePaymentCore } from "../payments/exclude";
import { requireTenantUser } from "../requireTenantUser";

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
  },
  returns: v.null(),
  handler: async (ctx, { paymentId, reason }) => {
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

    const result = await excludePaymentCore(
      ctx,
      { userId, tenantId, role },
      { paymentRecordId: paymentId, cause: "voided", level: "reviewed", voidReason: trimmedReason },
      "side_deal",
    );
    if (!result.ok) {
      throw expectedError(`payment.${result.code}`, "This payment can't be voided right now. Reload and try again.");
    }
    return null;
  },
});
