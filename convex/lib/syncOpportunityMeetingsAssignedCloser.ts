import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { replaceMeetingAggregate } from "../reporting/writeHooks";

export async function syncOpportunityMeetingsAssignedCloser(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
  assignedCloserId: Id<"users"> | undefined,
): Promise<number> {
  let updatedCount = 0;

  for await (const meeting of ctx.db
    .query("meetings")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunityId))) {
    if (meeting.assignedCloserId === assignedCloserId) {
      continue;
    }

    const oldMeeting = meeting;
    await ctx.db.patch(meeting._id, { assignedCloserId });
    await replaceMeetingAggregate(ctx, oldMeeting, meeting._id);
    updatedCount += 1;
  }

  return updatedCount;
}
