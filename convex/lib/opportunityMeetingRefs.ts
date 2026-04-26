import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
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
  const opportunity = await ctx.db.get(opportunityId);
  if (!opportunity) {
    return;
  }

  let latestMeeting:
    | {
        _id: Id<"meetings">;
        scheduledAt: number;
      }
    | undefined;
  let nextMeeting:
    | {
        _id: Id<"meetings">;
        scheduledAt: number;
      }
    | undefined;

  for await (const meeting of ctx.db
    .query("meetings")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunityId))) {
    if (
      latestMeeting === undefined ||
      meeting.scheduledAt > latestMeeting.scheduledAt
    ) {
      latestMeeting = {
        _id: meeting._id,
        scheduledAt: meeting.scheduledAt,
      };
    }

    if (
      meeting.status === "scheduled" &&
      (nextMeeting === undefined || meeting.scheduledAt < nextMeeting.scheduledAt)
    ) {
      nextMeeting = {
        _id: meeting._id,
        scheduledAt: meeting.scheduledAt,
      };
    }
  }

  if (
    opportunity.latestMeetingId === latestMeeting?._id &&
    opportunity.latestMeetingAt === latestMeeting?.scheduledAt &&
    opportunity.nextMeetingId === nextMeeting?._id &&
    opportunity.nextMeetingAt === nextMeeting?.scheduledAt
  ) {
    return;
  }

  const now = Date.now();
  const nextOpportunity = {
    ...opportunity,
    latestMeetingId: latestMeeting?._id,
    latestMeetingAt: latestMeeting?.scheduledAt,
    nextMeetingId: nextMeeting?._id,
    nextMeetingAt: nextMeeting?.scheduledAt,
    updatedAt: now,
  };

  await ctx.db.patch(opportunityId, {
    latestMeetingId: latestMeeting?._id,
    latestMeetingAt: latestMeeting?.scheduledAt,
    nextMeetingId: nextMeeting?._id,
    nextMeetingAt: nextMeeting?.scheduledAt,
    updatedAt: now,
    latestActivityAt: computeLatestActivityAt(nextOpportunity),
  });
  await upsertOpportunitySearchProjection(ctx, opportunityId);
}
