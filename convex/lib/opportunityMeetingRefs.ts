import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { rebuildLeadCustomerSearchRow } from "../leadCustomers/projection";
import { computeLatestActivityAt } from "./opportunityActivity";
import { upsertOpportunitySearchProjection } from "./opportunitySearch";

/**
 * Keep denormalized meeting references on an opportunity in sync with its meetings.
 *
 * - `latestMeeting*` tracks the most recent meeting by `scheduledAt`
 * - `nextMeeting*` tracks the soonest meeting still in `"scheduled"` status
 */
export async function updateOpportunityMeetingRefs(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
): Promise<void> {
  const opportunity = await ctx.db.get("opportunities", opportunityId);
  if (!opportunity) {
    return;
  }

  const [latestMeeting, nextMeeting] = await Promise.all([
    ctx.db
      .query("meetings")
      .withIndex("by_opportunityId_and_scheduledAt", (q) =>
        q.eq("opportunityId", opportunityId),
      )
      .order("desc")
      .first(),
    ctx.db
      .query("meetings")
      .withIndex("by_opportunityId_and_status_and_scheduledAt", (q) =>
        q.eq("opportunityId", opportunityId).eq("status", "scheduled"),
      )
      .first(),
  ]);
  if (
    [latestMeeting, nextMeeting].some(
      (m) => m && m.tenantId !== opportunity.tenantId,
    )
  )
    throw new Error("Meeting reference tenant mismatch");

  if (
    opportunity.latestMeetingId === latestMeeting?._id &&
    opportunity.latestMeetingAt === latestMeeting?.scheduledAt &&
    opportunity.nextMeetingId === nextMeeting?._id &&
    opportunity.nextMeetingAt === nextMeeting?.scheduledAt
  ) {
    return;
  }

  const nextOpportunity = {
    ...opportunity,
    latestMeetingId: latestMeeting?._id,
    latestMeetingAt: latestMeeting?.scheduledAt,
    nextMeetingId: nextMeeting?._id,
    nextMeetingAt: nextMeeting?.scheduledAt,
  };

  await ctx.db.patch("opportunities", opportunityId, {
    latestMeetingId: latestMeeting?._id,
    latestMeetingAt: latestMeeting?.scheduledAt,
    nextMeetingId: nextMeeting?._id,
    nextMeetingAt: nextMeeting?.scheduledAt,
    latestActivityAt: computeLatestActivityAt(nextOpportunity),
  });
  await upsertOpportunitySearchProjection(ctx, opportunityId);
  await rebuildLeadCustomerSearchRow(
    ctx,
    opportunity.tenantId,
    opportunity.leadId,
  );
}
