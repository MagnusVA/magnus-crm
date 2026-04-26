import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";
import { patchOpportunityLifecycle } from "../lib/opportunityActivity";
import {
  rollbackCustomerConversionIfEmpty,
  syncCustomerPaymentSummary,
} from "../lib/paymentHelpers";
import { isSideDeal, isSideDealOrigin } from "../lib/sideDeals";
import {
  applyPaymentStatsDelta,
  updateTenantStats,
} from "../lib/tenantStatsHelper";
import { requireTenantUser } from "../requireTenantUser";
import { replacePaymentAggregate } from "../reporting/writeHooks";

export const voidPayment = mutation({
  args: {
    paymentId: v.id("paymentRecords"),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { paymentId, reason }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const now = Date.now();
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      throw new Error("Void reason is required.");
    }

    const payment = await ctx.db.get(paymentId);
    if (!payment || payment.tenantId !== tenantId) {
      throw new Error("Payment not found.");
    }
    if (payment.status === "disputed") {
      throw new Error("Already voided.");
    }
    if (payment.status !== "recorded") {
      throw new Error("Only recorded side-deal payments can be voided here.");
    }
    if (!payment.opportunityId) {
      throw new Error("Only opportunity payments can be voided here.");
    }
    if (!isSideDealOrigin(payment.origin)) {
      throw new Error("Only side-deal payments can be voided via this mutation.");
    }

    const opportunity = await ctx.db.get(payment.opportunityId);
    if (
      !opportunity ||
      opportunity.tenantId !== tenantId ||
      !isSideDeal(opportunity)
    ) {
      throw new Error("Only side-deal payments can be voided via this mutation.");
    }
    if (opportunity.status !== "payment_received") {
      throw new Error(
        `Cannot void a side-deal payment while opportunity is "${opportunity.status}".`,
      );
    }

    await ctx.db.patch(paymentId, {
      status: "disputed",
      statusChangedAt: now,
    });

    await patchOpportunityLifecycle(ctx, payment.opportunityId, {
      status: "lost",
      lostAt: now,
      lostByUserId: userId,
      lostReason: `Payment voided: ${trimmedReason}`,
      paymentReceivedAt: undefined,
      updatedAt: now,
    });

    await replacePaymentAggregate(ctx, payment, paymentId);
    await applyPaymentStatsDelta(ctx, tenantId, {
      commissionable: payment.commissionable,
      paymentType: payment.paymentType,
      amountMinorDelta: -payment.amountMinor,
      wonDealDelta: -1,
      activeOpportunityDelta: 0,
    });
    await updateTenantStats(ctx, tenantId, { lostDeals: 1 });

    if (payment.customerId) {
      const rollback = await rollbackCustomerConversionIfEmpty(ctx, {
        customerId: payment.customerId,
        opportunityId: payment.opportunityId,
        actorUserId: userId,
      });
      if (!rollback.rolledBack) {
        await syncCustomerPaymentSummary(ctx, payment.customerId);
      }
    }

    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "payment",
      entityId: paymentId,
      eventType: "payment.voided",
      source: "admin",
      actorUserId: userId,
      fromStatus: payment.status,
      toStatus: "disputed",
      reason: trimmedReason,
      occurredAt: now,
      metadata: {
        opportunityId: payment.opportunityId,
        origin: payment.origin,
        sideDeal: true,
      },
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "opportunity",
      entityId: payment.opportunityId,
      eventType: "opportunity.status_changed",
      source: "admin",
      actorUserId: userId,
      fromStatus: opportunity.status,
      toStatus: "lost",
      reason: `Payment voided: ${trimmedReason}`,
      occurredAt: now,
      metadata: {
        source: "side_deal",
        paymentId,
      },
    });

    return null;
  },
});
