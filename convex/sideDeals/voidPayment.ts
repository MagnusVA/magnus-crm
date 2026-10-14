import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";
import { log } from "../lib/observability/log";
import { transitionOpportunity } from "../lib/opportunityActivity";
import {
  rollbackCustomerConversionIfEmpty,
  syncCustomerPaymentSummary,
} from "../lib/paymentHelpers";
import { isSideDeal, isSideDealOrigin } from "../lib/sideDeals";
import { refreshSoldProgramCachesForOpportunity } from "../lib/soldProgramCache";
import { applyPaymentStatsDelta } from "../lib/tenantStatsHelper";
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
    if (!isSideDealOrigin(payment.origin)) {
      throw new Error("Only side-deal payments can be voided via this mutation.");
    }

    const opportunity = await ctx.db.get("opportunities", payment.opportunityId);
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

    await ctx.db.patch("paymentRecords", paymentId, {
      status: "disputed",
      statusChangedAt: now,
    });
    await refreshSoldProgramCachesForOpportunity(ctx, {
      tenantId,
      opportunityId: payment.opportunityId,
    });

    await transitionOpportunity(ctx, payment.opportunityId, {
      to: "lost",
      fields: {
        lostAt: now,
        lostByUserId: userId,
        lostReason: `Payment voided: ${trimmedReason}`,
        paymentReceivedAt: undefined,
        updatedAt: now,
      },
      exception: "payment_voided",
      source: "admin",
      actorUserId: userId,
      reason: `Payment voided: ${trimmedReason}`,
      occurredAt: now,
      metadata: {
        source: "side_deal",
        paymentId,
      },
    });

    await replacePaymentAggregate(ctx, payment, paymentId);
    await applyPaymentStatsDelta(ctx, tenantId, {
      commissionable: payment.commissionable,
      paymentType: payment.paymentType,
      amountMinorDelta: -payment.amountMinor,
    });

    if (payment.customerId) {
      const rollback = await rollbackCustomerConversionIfEmpty(ctx, {
        customerId: payment.customerId,
        opportunityId: payment.opportunityId,
        actorUserId: userId,
      });
      if (!rollback.rolledBack) {
        log.info("side_deals.void_payment.rollback_skipped", {
          tenantId,
          paymentId,
          customerId: payment.customerId,
          reason: "customer_retained",
        });
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

    return null;
  },
});
