import {
  requestOpportunityProjections,
  requestMeetingProjection,
} from "../operations/meetingStats";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { rebuildLeadCustomerSearchRow } from "../leadCustomers/projection";
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
  const opportunity = await ctx.db.get("opportunities", args.opportunityId);
  if (opportunity && opportunity.tenantId === args.tenantId) {
    await ctx.db.patch("opportunities", args.opportunityId, {
      soldProgramId: args.programId,
      soldProgramName: args.programName,
    });
    await requestOpportunityProjections(ctx, args.opportunityId);
    await rebuildQualificationRowsForOpportunity(ctx, args.opportunityId);
    await rebuildLeadCustomerSearchRow(
      ctx,
      opportunity.tenantId,
      opportunity.leadId,
    );
  }

  if (args.meetingId) {
    const meeting = await ctx.db.get("meetings", args.meetingId);
    if (
      meeting &&
      meeting.tenantId === args.tenantId &&
      meeting.opportunityId === args.opportunityId
    ) {
      await requestMeetingProjection(ctx, args.tenantId, args.meetingId);
      await ctx.db.patch("meetings", args.meetingId, {
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
  const payments = await latestValidPayments(ctx, args.opportunityId);
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

  const opportunity = await ctx.db.get("opportunities", args.opportunityId);
  if (opportunity && opportunity.tenantId === args.tenantId) {
    await ctx.db.patch("opportunities", args.opportunityId, patch);
    await requestOpportunityProjections(ctx, args.opportunityId);
    await rebuildQualificationRowsForOpportunity(ctx, args.opportunityId);
    await rebuildLeadCustomerSearchRow(
      ctx,
      opportunity.tenantId,
      opportunity.leadId,
    );
  }

  // Meeting caches are refreshed by the paginated reporting job above.
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

  const payments = await latestValidPayments(ctx, opportunityId);

  await refreshSoldProgramCachesFromPayments(ctx, {
    tenantId: args.tenantId,
    opportunityId,
    payments,
  });

  if (!args.payment.customerId || args.payment.contextType !== "opportunity") {
    return;
  }

  const customer = await ctx.db.get("customers", args.payment.customerId);
  if (
    customer &&
    customer.tenantId === args.tenantId &&
    customer.winningOpportunityId === opportunityId
  ) {
    await ctx.db.patch("customers", customer._id, {
      programId: args.payment.programId,
      programName: args.payment.programName,
    });
  }
}

async function latestValidPayments(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
) {
  const rows = await Promise.all(
    (["recorded", "verified"] as const).flatMap((status) => [
      ctx.db
        .query("paymentRecords")
        .withIndex("by_opportunityId_and_status_and_recordedAt", (q) =>
          q.eq("opportunityId", opportunityId).eq("status", status),
        )
        .order("desc")
        .first(),
      ctx.db
        .query("paymentRecords")
        .withIndex(
          "by_originatingOpportunityId_and_status_and_recordedAt",
          (q) =>
            q
              .eq("originatingOpportunityId", opportunityId)
              .eq("status", status),
        )
        .order("desc")
        .first(),
    ]),
  );
  return rows.filter((row): row is Doc<"paymentRecords"> => row !== null);
}
