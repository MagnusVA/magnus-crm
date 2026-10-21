import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";
import { syncPersonEnrollments } from "../lib/enrollments";
import { toAmountMinor, validateCurrency } from "../lib/formatMoney";
import { recordPayment } from "../lib/leadLifecycle";
import { transitionOpportunity } from "../lib/opportunityActivity";
import {
  assertPaymentRow,
  resolveProgramForWrite,
  type CommissionableOrigin,
} from "../lib/paymentHelpers";
import { paymentTypeValidator, resolvePaymentType } from "../lib/paymentTypes";
import { isSideDeal } from "../lib/sideDeals";
import { setSoldProgramCaches } from "../lib/soldProgramCache";
import { expirePendingStaleOpportunityNudges } from "../lib/staleOpportunityNudges";
import { validateTransition } from "../lib/statusTransitions";
import { applyPaymentStatsDelta } from "../lib/tenantStatsHelper";
import { requireTenantUser } from "../requireTenantUser";
import { insertPaymentAggregate } from "../reporting/writeHooks";

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
  }),
  handler: async (ctx, args) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);
    const now = Date.now();
    const isAdmin = role === "tenant_master" || role === "tenant_admin";

    const opportunity = await ctx.db.get("opportunities", args.opportunityId);
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
      opportunityId: args.opportunityId,
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
      origin,
    });
    await recordPayment(ctx, paymentId);

    await insertPaymentAggregate(ctx, paymentId);
    await setSoldProgramCaches(ctx, {
      tenantId,
      opportunityId: args.opportunityId,
      programId: program._id,
      programName: program.name,
    });
    await transitionOpportunity(ctx, args.opportunityId, {
      to: "payment_received",
      fields: { paymentReceivedAt: now, updatedAt: now },
      source: isAdmin ? "admin" : "closer",
      actorUserId: userId,
      occurredAt: now,
      metadata: { source: "side_deal", paymentId },
    });
    await expirePendingStaleOpportunityNudges(ctx, args.opportunityId);
    await applyPaymentStatsDelta(ctx, tenantId, {
      commissionable: true,
      paymentType,
      amountMinorDelta: amountMinor,
    });

    // The person's enrollments follow their payments, and their first one
    // makes them a customer, with or without an email
    // (docs/plans/phase-4-customers.md §4.1, §4.2).
    await syncPersonEnrollments(ctx, {
      tenantId,
      leadId: opportunity.leadId,
      now,
      source: isAdmin ? "admin" : "closer",
      actorUserId: userId,
    });

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

    return { paymentId };
  },
});
