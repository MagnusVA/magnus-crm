import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { replaceMeetingAggregate } from "../reporting/writeHooks";
import { callTypeFor, type CallType } from "./callType";
import { updateOpportunityMeetingRefs } from "./opportunityMeetingRefs";

// Keeps every meeting's stored call type on the rule in `callType.ts`: a
// first call until one is held on the deal. A booking types its new meeting
// when it inserts it; anything that can change another meeting's type (a
// result recorded or corrected, a call moved in time or to another deal)
// re-types the whole deal here.

/** A deal's meetings are read whole; past this many the write fails. */
export const DEAL_MEETING_LIMIT = 1000;

export type CallTypeChange = {
  meetingId: Id<"meetings">;
  /** The stored type before, `undefined` for a meeting that had none. */
  from: CallType | undefined;
  to: CallType;
};

async function readDealMeetings(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
  scheduledBefore?: number,
): Promise<Doc<"meetings">[]> {
  const meetings = await ctx.db
    .query("meetings")
    .withIndex("by_opportunityId_and_scheduledAt", (q) =>
      scheduledBefore === undefined
        ? q.eq("opportunityId", opportunityId)
        : q.eq("opportunityId", opportunityId).lt("scheduledAt", scheduledBefore),
    )
    .take(DEAL_MEETING_LIMIT + 1);
  // The type has to be right for every meeting, so a partial read can't do.
  if (meetings.length > DEAL_MEETING_LIMIT)
    throw new Error(
      "Opportunity exceeds the call type limit; review its booking history",
    );
  return meetings;
}

/**
 * The type a meeting about to be booked on the deal gets. Only meetings
 * scheduled before it can make it a follow-up, so only those are read.
 */
export async function callTypeForBooking(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
  scheduledAt: number,
): Promise<CallType> {
  const earlier = await readDealMeetings(ctx, opportunityId, scheduledAt);
  // The meeting has no id yet and isn't among `earlier`, so any id will do.
  return callTypeFor({ _id: "" as Id<"meetings">, scheduledAt }, earlier);
}

/**
 * Re-types the deal's meetings without touching its meeting refs. It patches
 * only `callClassification`, directly rather than through
 * `patchMeetingLifecycle`, so it never starts another re-check; each patch
 * re-keys `meetingsByStatus` and queues the meeting's projection like any
 * other meeting write.
 */
export async function retypeDealMeetingsWithoutRefs(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
): Promise<{ changed: CallTypeChange[] }> {
  const meetings = await readDealMeetings(ctx, opportunityId);
  const changed: CallTypeChange[] = [];
  for (const meeting of meetings) {
    const to = callTypeFor(meeting, meetings);
    if (meeting.callClassification === to) continue;
    await ctx.db.patch("meetings", meeting._id, { callClassification: to });
    await replaceMeetingAggregate(ctx, meeting, meeting._id);
    changed.push({ meetingId: meeting._id, from: meeting.callClassification, to });
  }
  return { changed };
}

/**
 * Re-types every meeting on the deal and returns what changed. The call-type
 * backfill calls it once per deal; it goes through the same side effects as
 * any meeting write, the deal's meeting refs included.
 */
export async function retypeDealMeetings(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
): Promise<{ changed: CallTypeChange[] }> {
  const result = await retypeDealMeetingsWithoutRefs(ctx, opportunityId);
  if (result.changed.length > 0) await updateOpportunityMeetingRefs(ctx, opportunityId);
  return result;
}
