import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server";
import type { OpportunityStatus } from "../convex/lib/statusTransitions";
import { meetingDayKey } from "../convex/operations/meetingStats";
import { missedMeetingLossReason } from "../convex/opportunities/stages";
import { stageFields } from "./dealStageFixtures";

// PR 6 of Phase 5 (docs/plans/phase-5-deal-status.md §6.5, §6.6): the reports
// and operations screens read the deal's stage and outcome.

/**
 * Rewrites only the deal's stored status, leaving its stage and outcome: a
 * screen that reads the stage shows the deal as before, one that reads the
 * status doesn't.
 */
export async function setStoredStatus(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
  status: OpportunityStatus,
): Promise<void> {
  await ctx.db.patch("opportunities", opportunityId, { status });
}

/**
 * The operations meeting stats buckets of the UTC days in [scheduledFrom,
 * scheduledTo), summed by meeting status the way the removed
 * phoneSales.getPhoneSalesStats summed them: `won` counts the meetings whose
 * deal was paid when they were bucketed.
 */
export async function meetingStatsTotals(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    scheduledFrom: number;
    scheduledTo: number;
    soldProgramId?: Id<"tenantPrograms">;
    opportunityStatus?: OpportunityStatus;
  },
) {
  const rows = await ctx.db
    .query("operationsMeetingStatsV2")
    .withIndex("by_tenantId_and_dayKey", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .gte("dayKey", meetingDayKey(args.scheduledFrom))
        .lt("dayKey", meetingDayKey(args.scheduledTo)),
    )
    .take(8192);
  const totals = { scheduled: 0, completed: 0, canceled: 0, noShows: 0, won: 0 };
  for (const row of rows) {
    if (args.soldProgramId && row.soldProgramId !== args.soldProgramId) continue;
    if (args.opportunityStatus && row.opportunityStatus !== args.opportunityStatus) continue;
    totals.scheduled += row.count;
    if (row.meetingStatus === "completed") totals.completed += row.count;
    if (row.meetingStatus === "canceled") totals.canceled += row.count;
    if (row.meetingStatus === "no_show") totals.noShows += row.count;
    if (row.opportunityStatus === "payment_received") totals.won += row.count;
  }
  return totals;
}

/**
 * Puts a deal at `status` with the stage, outcome and missed meeting loss the
 * dual write gives it, and nothing else: no aggregates, no copies. The
 * meetings keep the status they copied, so a screen that reads the copy shows
 * the old one.
 */
export async function moveDealTo(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
  status: OpportunityStatus,
  fields: Partial<Doc<"opportunities">> = {},
): Promise<void> {
  const deal = (await ctx.db.get("opportunities", opportunityId))!;
  const reason = missedMeetingLossReason(status);
  await ctx.db.patch("opportunities", opportunityId, {
    ...stageFields(status, deal.source ?? "calendly"),
    ...(reason ? { lostReason: reason, lostAt: deal.updatedAt } : {}),
    ...fields,
  });
}
