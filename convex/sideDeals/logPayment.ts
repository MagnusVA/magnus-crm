import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { executeConversion } from "../customers/conversion";
import { emitDomainEvent } from "../lib/domainEvents";
import { toAmountMinor, validateCurrency } from "../lib/formatMoney";
import { patchOpportunityLifecycle } from "../lib/opportunityActivity";
import {
  assertPaymentRow,
  resolveProgramForWrite,
  syncCustomerPaymentSummary,
  type CommissionableOrigin,
} from "../lib/paymentHelpers";
import { paymentTypeValidator, resolvePaymentType } from "../lib/paymentTypes";
import { isSideDeal } from "../lib/sideDeals";
import { expirePendingStaleOpportunityNudges } from "../lib/staleOpportunityNudges";
import { validateTransition } from "../lib/statusTransitions";
import {
  applyPaymentStatsDelta,
  isActiveOpportunityStatus,
} from "../lib/tenantStatsHelper";
import { requireTenantUser } from "../requireTenantUser";
import {
  insertPaymentAggregate,
  replacePaymentAggregate,
} from "../reporting/writeHooks";

export const logPayment = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    amount: v.number(),
    currency: v.string(),
    programId: v.id("tenantPrograms"),
    paymentType: paymentTypeValidator,
    proofFileId: v.optional(v.id("_storage")),
  },
  returns: v.object({
    paymentId: v.id("paymentRecords"),
    customerId: v.optional(v.id("customers")),
  }),
  handler: async (ctx, args) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);
    const now = Date.now();
    const isAdmin = role === "tenant_master" || role === "tenant_admin";

    const opportunity = await ctx.db.get(args.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found.");
    }
    if (!isSideDeal(opportunity)) {
      throw new Error("This mutation only accepts side-deal opportunities.");
    }
    if (!isAdmin && opportunity.assignedCloserId !== userId) {
      throw new Error("You are not the assigned closer for this opportunity.");
    }
    if (!validateTransition(opportunity.status, "payment_received")) {
      throw new Error(
        `Opportunity status "${opportunity.status}" cannot transition to "payment_received".`,
      );
    }
    if (args.amount <= 0) {
      throw new Error("Payment amount must be greater than zero.");
    }
    if (!opportunity.assignedCloserId) {
      throw new Error("Opportunity must be assigned to a closer before payment.");
    }

    const currency = validateCurrency(args.currency);
    const amountMinor = toAmountMinor(args.amount);
    const program = await resolveProgramForWrite(ctx, tenantId, args.programId);
    const paymentType = resolvePaymentType(args.paymentType);
    const origin: CommissionableOrigin = isAdmin
      ? "admin_side_deal"
      : "closer_side_deal";

    assertPaymentRow({
      tenantId,
      commissionable: true,
      attributedCloserId: opportunity.assignedCloserId,
      recordedByUserId: userId,
      origin,
      contextType: "opportunity",
      opportunityId: args.opportunityId,
      customerId: undefined,
      programId: program._id,
      paymentType,
    });

    const paymentId = await ctx.db.insert("paymentRecords", {
      tenantId,
      opportunityId: args.opportunityId,
      meetingId: undefined,
      attributedCloserId: opportunity.assignedCloserId,
      recordedByUserId: userId,
      commissionable: true,
      amountMinor,
      currency,
      programId: program._id,
      programName: program.name,
      paymentType,
      proofFileId: args.proofFileId ?? undefined,
      status: "recorded",
      statusChangedAt: now,
      recordedAt: now,
      contextType: "opportunity",
      origin,
    });

    const paymentBeforeCustomerLink = await insertPaymentAggregate(ctx, paymentId);
    await patchOpportunityLifecycle(ctx, args.opportunityId, {
      status: "payment_received",
      paymentReceivedAt: now,
      updatedAt: now,
    });
    await expirePendingStaleOpportunityNudges(ctx, args.opportunityId);
    await applyPaymentStatsDelta(ctx, tenantId, {
      commissionable: true,
      paymentType,
      amountMinorDelta: amountMinor,
      wonDealDelta: 1,
      activeOpportunityDelta: isActiveOpportunityStatus(opportunity.status)
        ? -1
        : 0,
    });

    let customerId = await executeConversion(ctx, {
      tenantId,
      leadId: opportunity.leadId,
      convertedByUserId: userId,
      winningOpportunityId: args.opportunityId,
      winningMeetingId: undefined,
    });

    if (!customerId) {
      const existingCustomer = await ctx.db
        .query("customers")
        .withIndex("by_tenantId_and_leadId", (q) =>
          q.eq("tenantId", tenantId).eq("leadId", opportunity.leadId),
        )
        .first();
      customerId = existingCustomer?._id ?? null;
    }

    if (customerId) {
      await ctx.db.patch(paymentId, { customerId });
      await replacePaymentAggregate(ctx, paymentBeforeCustomerLink, paymentId);
      await syncCustomerPaymentSummary(ctx, customerId);
    }

    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "payment",
      entityId: paymentId,
      eventType: "payment.recorded",
      source: isAdmin ? "admin" : "closer",
      actorUserId: userId,
      toStatus: "recorded",
      occurredAt: now,
      metadata: {
        opportunityId: args.opportunityId,
        amountMinor,
        currency,
        programId: program._id,
        programName: program.name,
        paymentType,
        origin,
        sideDeal: true,
      },
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "opportunity",
      entityId: args.opportunityId,
      eventType: "opportunity.status_changed",
      source: isAdmin ? "admin" : "closer",
      actorUserId: userId,
      fromStatus: opportunity.status,
      toStatus: "payment_received",
      occurredAt: now,
      metadata: { source: "side_deal", paymentId },
    });

    return { paymentId, customerId: customerId ?? undefined };
  },
});
