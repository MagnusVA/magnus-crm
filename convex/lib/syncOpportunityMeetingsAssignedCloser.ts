import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { replaceMeetingAggregate } from "../reporting/writeHooks";

export async function syncOpportunityMeetingsAssignedCloser(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
  assignedCloserId: Id<"users"> | undefined,
): Promise<number> {
  if (!assignedCloserId) throw new Error("A closer is required");
  const opportunity = await ctx.db.get("opportunities", opportunityId);
  const closer = await ctx.db.get("users", assignedCloserId);
  if (
    !opportunity ||
    !closer ||
    closer.tenantId !== opportunity.tenantId ||
    closer.role !== "closer" ||
    !closer.isActive
  )
    throw new Error("Invalid closer assignment");
  const meetings = await ctx.db
    .query("meetings")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunityId))
    .take(1001);
  // Assignment affects access and must commit atomically, unlike reporting.
  if (meetings.length > 1000)
    throw new Error(
      "Opportunity exceeds the atomic reassignment limit; review its booking history",
    );
  let updatedCount = 0;

  for (const meeting of meetings) {
    if (meeting.tenantId !== opportunity.tenantId)
      throw new Error("Meeting tenant mismatch");
    if (meeting.assignedCloserId === assignedCloserId) {
      continue;
    }

    const oldMeeting = meeting;
    await ctx.db.patch("meetings", meeting._id, { assignedCloserId });
    await replaceMeetingAggregate(ctx, oldMeeting, meeting._id);
    updatedCount += 1;
  }

  return updatedCount;
}
