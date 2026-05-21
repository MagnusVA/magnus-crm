import type { Id } from "../_generated/dataModel";
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
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", args.opportunityId))
    .order("desc")
    .take(25);
  const latestRecordedPayment = payments.find(
    (payment) => payment.tenantId === args.tenantId && payment.status !== "disputed",
  );

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
