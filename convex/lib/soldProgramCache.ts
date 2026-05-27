import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { rebuildQualificationRowsForOpportunity } from "../operations/projections";

export async function setSoldProgramCaches(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    opportunityId: Id<"opportunities">;
    meetingId?: Id<"meetings">;
    programId: Id<"tenantPrograms">;
    programName: string;
  },
) {
  const opportunity = await ctx.db.get(args.opportunityId);
  if (opportunity && opportunity.tenantId === args.tenantId) {
    await ctx.db.patch(args.opportunityId, {
      soldProgramId: args.programId,
      soldProgramName: args.programName,
    });
    await rebuildQualificationRowsForOpportunity(ctx, args.opportunityId);
  }

  if (args.meetingId) {
    const meeting = await ctx.db.get(args.meetingId);
    if (
      meeting &&
      meeting.tenantId === args.tenantId &&
      meeting.opportunityId === args.opportunityId
    ) {
      await ctx.db.patch(args.meetingId, {
        soldProgramId: args.programId,
        soldProgramName: args.programName,
      });
    }
  }
}

export async function refreshSoldProgramCachesForOpportunity(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    opportunityId: Id<"opportunities">;
  },
) {
  const payments = await ctx.db
    .query("paymentRecords")
    .withIndex("by_opportunityId_and_recordedAt", (q) =>
      q.eq("opportunityId", args.opportunityId),
    )
    .order("desc")
    .take(25);
  await refreshSoldProgramCachesFromPayments(ctx, {
    ...args,
    payments,
  });
}

async function refreshSoldProgramCachesFromPayments(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    opportunityId: Id<"opportunities">;
    payments: Array<Doc<"paymentRecords">>;
  },
) {
  const latestRecordedPayment = args.payments
    .filter(
      (payment) =>
        payment.tenantId === args.tenantId && payment.status !== "disputed",
    )
    .sort((left, right) => right.recordedAt - left.recordedAt)[0];

  const patch = latestRecordedPayment
    ? {
        soldProgramId: latestRecordedPayment.programId,
        soldProgramName: latestRecordedPayment.programName,
      }
    : {
        soldProgramId: undefined,
        soldProgramName: undefined,
      };

  const opportunity = await ctx.db.get(args.opportunityId);
  if (opportunity && opportunity.tenantId === args.tenantId) {
    await ctx.db.patch(args.opportunityId, patch);
    await rebuildQualificationRowsForOpportunity(ctx, args.opportunityId);
  }

  const meetings = await ctx.db
    .query("meetings")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", args.opportunityId))
    .take(100);
  for (const meeting of meetings) {
    if (meeting.tenantId === args.tenantId) {
      await ctx.db.patch(meeting._id, patch);
    }
  }
}

export async function refreshSoldProgramCachesForPaymentContext(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    payment: Doc<"paymentRecords">;
  },
) {
  const opportunityId =
    args.payment.opportunityId ?? args.payment.originatingOpportunityId;
  if (!opportunityId) {
    return;
  }

  const [opportunityPayments, customerContextPayments] = await Promise.all([
    ctx.db
      .query("paymentRecords")
      .withIndex("by_opportunityId_and_recordedAt", (q) =>
        q.eq("opportunityId", opportunityId),
      )
      .order("desc")
      .take(50),
    ctx.db
      .query("paymentRecords")
      .withIndex("by_originatingOpportunityId_and_recordedAt", (q) =>
        q.eq("originatingOpportunityId", opportunityId),
      )
      .order("desc")
      .take(50),
  ]);

  await refreshSoldProgramCachesFromPayments(ctx, {
    tenantId: args.tenantId,
    opportunityId,
    payments: [...opportunityPayments, ...customerContextPayments],
  });

  if (!args.payment.customerId || args.payment.contextType !== "opportunity") {
    return;
  }

  const customer = await ctx.db.get(args.payment.customerId);
  if (
    customer &&
    customer.tenantId === args.tenantId &&
    customer.winningOpportunityId === opportunityId
  ) {
    await ctx.db.patch(customer._id, {
      programId: args.payment.programId,
      programName: args.payment.programName,
    });
  }
}
