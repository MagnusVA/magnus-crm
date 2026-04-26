import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { executeConversion } from "../customers/conversion";
import { emitDomainEvent } from "../lib/domainEvents";
import { toAmountMinor, validateCurrency } from "../lib/formatMoney";
import {
  assertPaymentRow,
  resolveProgramForWrite,
  syncCustomerPaymentSummary,
  type CommissionableOrigin,
} from "../lib/paymentHelpers";
import { assertOverranReviewStillPending } from "../lib/overranReviewGuards";
import { patchOpportunityLifecycle } from "../lib/opportunityActivity";
import { paymentTypeValidator, resolvePaymentType } from "../lib/paymentTypes";
import { validateTransition } from "../lib/statusTransitions";
import {
  applyPaymentStatsDelta,
  isActiveOpportunityStatus,
} from "../lib/tenantStatsHelper";
import { requireTenantUser } from "../requireTenantUser";
import {
  insertPaymentAggregate,
} from "../reporting/writeHooks";

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireTenantUser(ctx, ["closer", "tenant_master", "tenant_admin"]);
    return await ctx.storage.generateUploadUrl();
  },
});

export const logPayment = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    meetingId: v.id("meetings"),
    amount: v.number(),
    currency: v.string(),
    programId: v.id("tenantPrograms"),
    paymentType: paymentTypeValidator,
    proofFileId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    console.log("[Closer:Payment] logPayment called", {
      opportunityId: args.opportunityId,
      meetingId: args.meetingId,
      amount: args.amount,
      currency: args.currency,
      programId: args.programId,
      paymentType: args.paymentType,
      hasProofFile: !!args.proofFileId,
    });
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);

    const opportunity = await ctx.db.get(args.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }
    if (role === "closer" && opportunity.assignedCloserId !== userId) {
      throw new Error("Not your opportunity");
    }

    const meeting = await ctx.db.get(args.meetingId);
    if (
      !meeting ||
      meeting.tenantId !== tenantId ||
      meeting.opportunityId !== args.opportunityId
    ) {
      throw new Error("Meeting does not belong to this opportunity");
    }
    if (opportunity.status === "meeting_overran") {
      await assertOverranReviewStillPending(ctx, opportunity._id);
    }
    if (!validateTransition(opportunity.status, "payment_received")) {
      throw new Error(
        `Cannot log payment for opportunity with status "${opportunity.status}"`,
      );
    }
    if (args.amount <= 0) {
      throw new Error("Payment amount must be positive");
    }

    const currency = validateCurrency(args.currency);
    const amountMinor = toAmountMinor(args.amount);
    const now = Date.now();
    const program = await resolveProgramForWrite(ctx, tenantId, args.programId);
    const paymentType = resolvePaymentType(args.paymentType);

    if (role !== "closer" && !opportunity.assignedCloserId) {
      throw new Error("Assign a closer before logging a commissionable payment");
    }
    const attributedCloserId =
      role === "closer" ? userId : opportunity.assignedCloserId!;
    const origin: CommissionableOrigin =
      role === "closer" ? "closer_meeting" : "admin_meeting";

    assertPaymentRow({
      tenantId,
      commissionable: true,
      attributedCloserId,
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
      meetingId: args.meetingId,
      attributedCloserId,
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
    await insertPaymentAggregate(ctx, paymentId);

    await patchOpportunityLifecycle(ctx, args.opportunityId, {
      status: "payment_received",
      paymentReceivedAt: now,
      updatedAt: now,
    });
    await applyPaymentStatsDelta(ctx, tenantId, {
      commissionable: true,
      paymentType,
      amountMinorDelta: amountMinor,
      wonDealDelta: 1,
      activeOpportunityDelta: isActiveOpportunityStatus(opportunity.status)
        ? -1
        : 0,
    });

    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "payment",
      entityId: paymentId,
      eventType: "payment.recorded",
      source: role === "closer" ? "closer" : "admin",
      actorUserId: userId,
      toStatus: "recorded",
      metadata: {
        opportunityId: args.opportunityId,
        meetingId: args.meetingId,
        amountMinor,
        currency,
        programId: program._id,
        programName: program.name,
        paymentType,
        commissionable: true,
        attributedCloserId,
        recordedByUserId: userId,
        origin,
      },
      occurredAt: now,
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "opportunity",
      entityId: args.opportunityId,
      eventType: "opportunity.status_changed",
      source: role === "closer" ? "closer" : "admin",
      actorUserId: userId,
      fromStatus: opportunity.status,
      toStatus: "payment_received",
      occurredAt: now,
    });

    const customerId = await executeConversion(ctx, {
      tenantId,
      leadId: opportunity.leadId,
      convertedByUserId: userId,
      winningOpportunityId: args.opportunityId,
      winningMeetingId: args.meetingId,
    });

    if (customerId) {
      await ctx.db.patch(paymentId, { customerId });
      await syncCustomerPaymentSummary(ctx, customerId);
    } else {
      const existingCustomer = await ctx.db
        .query("customers")
        .withIndex("by_tenantId_and_leadId", (q) =>
          q.eq("tenantId", tenantId).eq("leadId", opportunity.leadId),
        )
        .first();
      if (existingCustomer) {
        await ctx.db.patch(paymentId, { customerId: existingCustomer._id });
        await syncCustomerPaymentSummary(ctx, existingCustomer._id);
      }
    }

    return paymentId;
  },
});

export const getPaymentProofUrl = query({
  args: { paymentRecordId: v.id("paymentRecords") },
  handler: async (ctx, { paymentRecordId }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);

    const record = await ctx.db.get(paymentRecordId);
    if (!record || record.tenantId !== tenantId || !record.proofFileId) {
      return null;
    }

    return await ctx.storage.getUrl(record.proofFileId);
  },
});
