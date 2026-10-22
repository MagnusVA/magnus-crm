import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";
import { syncPersonEnrollments } from "../lib/enrollments";
import { correctLeadLifecycle } from "../lib/leadLifecycle";
import { transitionOpportunity } from "../lib/opportunityActivity";
import { isSideDeal, isSideDealOrigin } from "../lib/sideDeals";
import { refreshSoldProgramCachesForOpportunity } from "../lib/soldProgramCache";
import { applyPaymentStatsDelta } from "../lib/tenantStatsHelper";
import { describeDealState, isWonDeal } from "../opportunities/dealGuards";
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
    if (!isWonDeal(opportunity)) {
      throw new Error(
        `Cannot void a side-deal payment while the deal is "${describeDealState(opportunity)}".`,
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
      to: { stage: "closed", outcome: "lost" },
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

    // A disputed payment no longer counts: the enrollment it held moves to
    // the earliest payment left for its program, or goes, and a person left
    // with none is no longer a customer (§4.3).
    await syncPersonEnrollments(ctx, {
      tenantId,
      leadId: opportunity.leadId,
      now,
      source: "admin",
      actorUserId: userId,
    });
    // Voiding corrects a payment that shouldn't count, so the person's stage
    // follows what is left (docs/plans/phase-1-foundations.md §4.3).
    await correctLeadLifecycle(ctx, opportunity.leadId, "payment_voided", userId);

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
