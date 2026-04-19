import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { executeConversion } from "../customers/conversion";
import { toAmountMinor, validateCurrency } from "./formatMoney";
import { emitDomainEvent } from "./domainEvents";
import { updateTenantStats } from "./tenantStatsHelper";
import { syncCustomerPaymentSummary } from "./paymentHelpers";
import { insertPaymentAggregate } from "../reporting/writeHooks";

type PaymentOrigin =
  | "closer_meeting"
  | "closer_reminder"
  | "admin_meeting"
  | "customer_flow";

type FollowUpReason =
  | "closer_initiated"
  | "cancellation_follow_up"
  | "no_show_follow_up"
  | "admin_initiated"
  | "overran_review_resolution";

type FollowUpCreatedSource = "closer" | "admin" | "system";

type CreatePaymentRecordArgs = {
  tenantId: Id<"tenants">;
  opportunityId: Id<"opportunities">;
  meetingId: Id<"meetings">;
  actorUserId: Id<"users">;
  amount: number;
  currency: string;
  provider: string;
  referenceCode?: string;
  proofFileId?: Id<"_storage">;
  origin: PaymentOrigin;
  loggedByAdminUserId?: Id<"users">;
};

type CreateManualReminderArgs = {
  tenantId: Id<"tenants">;
  opportunityId: Id<"opportunities">;
  actorUserId: Id<"users">;
  note: string;
  reason: FollowUpReason;
  createdByUserId: Id<"users">;
  createdSource: FollowUpCreatedSource;
};

export async function createPaymentRecord(
  ctx: MutationCtx,
  args: CreatePaymentRecordArgs,
): Promise<Id<"paymentRecords">> {
  console.log("[OutcomeHelpers] createPaymentRecord called", {
    opportunityId: args.opportunityId,
    meetingId: args.meetingId,
    amount: args.amount,
  });

  if (args.amount <= 0) {
    throw new Error("Payment amount must be positive");
  }

  const currency = validateCurrency(args.currency);
  const provider = args.provider.trim();
  if (!provider) {
    throw new Error("Provider is required");
  }

  const opportunity = await ctx.db.get(args.opportunityId);
  if (!opportunity || opportunity.tenantId !== args.tenantId) {
    throw new Error("Opportunity not found");
  }

  const now = Date.now();
  const amountMinor = toAmountMinor(args.amount);
  const attributedCloserId =
    opportunity.assignedCloserId ?? args.actorUserId;

  const paymentId = await ctx.db.insert("paymentRecords", {
    tenantId: args.tenantId,
    opportunityId: args.opportunityId,
    meetingId: args.meetingId,
    closerId: attributedCloserId,
    amountMinor,
    currency,
    provider,
    referenceCode: args.referenceCode?.trim() || undefined,
    proofFileId: args.proofFileId ?? undefined,
    status: "recorded",
    statusChangedAt: now,
    recordedAt: now,
    contextType: "opportunity",
    origin: args.origin,
    loggedByAdminUserId: args.loggedByAdminUserId,
  });

  await insertPaymentAggregate(ctx, paymentId);
  await emitDomainEvent(ctx, {
    tenantId: args.tenantId,
    entityType: "payment",
    entityId: paymentId,
    eventType: "payment.recorded",
    source: "admin",
    actorUserId: args.actorUserId,
    toStatus: "recorded",
    occurredAt: now,
    metadata: {
      opportunityId: args.opportunityId,
      meetingId: args.meetingId,
      amountMinor,
      currency,
      attributedCloserId,
      loggedByAdminUserId: args.actorUserId,
      origin: args.origin,
    },
  });
  await updateTenantStats(ctx, args.tenantId, {
    wonDeals: 1,
    totalPaymentRecords: 1,
    totalRevenueMinor: amountMinor,
  });

  const customerId = await executeConversion(ctx, {
    tenantId: args.tenantId,
    leadId: opportunity.leadId,
    convertedByUserId: args.actorUserId,
    winningOpportunityId: args.opportunityId,
    winningMeetingId: args.meetingId,
  });

  if (customerId) {
    await ctx.db.patch(paymentId, { customerId });
    await syncCustomerPaymentSummary(ctx, customerId);
    return paymentId;
  }

  const existingCustomer = await ctx.db
    .query("customers")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", args.tenantId).eq("leadId", opportunity.leadId),
    )
    .first();
  if (existingCustomer) {
    await ctx.db.patch(paymentId, { customerId: existingCustomer._id });
    await syncCustomerPaymentSummary(ctx, existingCustomer._id);
  }

  return paymentId;
}

export async function createManualReminder(
  ctx: MutationCtx,
  args: CreateManualReminderArgs,
): Promise<Id<"followUps">> {
  const opportunity = await ctx.db.get(args.opportunityId);
  if (!opportunity || opportunity.tenantId !== args.tenantId) {
    throw new Error("Opportunity not found");
  }

  const note = args.note.trim();
  if (!note) {
    throw new Error("Reminder note is required");
  }

  const now = Date.now();
  const closerId = opportunity.assignedCloserId ?? args.actorUserId;
  const followUpId = await ctx.db.insert("followUps", {
    tenantId: args.tenantId,
    opportunityId: args.opportunityId,
    leadId: opportunity.leadId,
    closerId,
    type: "manual_reminder",
    reason: args.reason,
    reminderNote: note,
    status: "pending",
    createdAt: now,
    createdByUserId: args.createdByUserId,
    createdSource: args.createdSource,
  });

  await emitDomainEvent(ctx, {
    tenantId: args.tenantId,
    entityType: "followUp",
    entityId: followUpId,
    eventType: "followUp.created",
    source: "admin",
    actorUserId: args.actorUserId,
    toStatus: "pending",
    occurredAt: now,
    metadata: {
      opportunityId: args.opportunityId,
      type: "manual_reminder",
      createdVia: "overran_review_resolution",
      reason: args.reason,
    },
  });

  return followUpId;
}
