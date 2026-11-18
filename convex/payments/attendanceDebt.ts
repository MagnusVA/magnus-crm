import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { patchMeetingLifecycle } from "../lib/meetingLifecycle";

// Attendance owed after a Whop payment wins a deal (build contract §2.2): a
// win recorded without a call result still leaves each scheduled meeting's
// attendance for the closer to record. The marker is the meeting's end.
// Readers show it only while the meeting is `scheduled` and the deal is won,
// so a Calendly status change needs no hook here.
//
// Writes go through `patchMeetingLifecycle`. The marker changes neither the
// status nor the time, so no aggregate key, call type or meeting ref moves.

export const ATTENDANCE_DEBT_MEETING_LIMIT = 20;

async function scheduledMeetings(ctx: MutationCtx, deal: Doc<"opportunities">) {
  const meetings = await ctx.db.query("meetings")
    .withIndex("by_opportunityId_and_status_and_scheduledAt", (q) =>
      q.eq("opportunityId", deal._id).eq("status", "scheduled"))
    .take(ATTENDANCE_DEBT_MEETING_LIMIT + 1);
  if (meetings.length > ATTENDANCE_DEBT_MEETING_LIMIT) {
    throw new Error(`Deal ${deal._id} has more than ${ATTENDANCE_DEBT_MEETING_LIMIT} scheduled meetings`);
  }
  for (const meeting of meetings) {
    if (meeting.tenantId !== deal.tenantId) throw new Error(`Meeting ${meeting._id} is in another tenant`);
  }
  return meetings;
}

async function readDeal(ctx: MutationCtx, opportunityId: Id<"opportunities">) {
  const deal = await ctx.db.get("opportunities", opportunityId);
  if (!deal) throw new Error(`Deal ${opportunityId} not found`);
  return deal;
}

/**
 * Mark attendance owed on every scheduled meeting of a deal a Whop payment
 * just won, except `exceptMeetingId` (the meeting whose result is being
 * recorded in the same write). Call after the move to won.
 */
export async function markAttendanceOwed(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
  options: { exceptMeetingId?: Id<"meetings"> } = {},
): Promise<{ meetingIds: Id<"meetings">[] }> {
  const deal = await readDeal(ctx, opportunityId);
  if (deal.stage !== "closed" || deal.outcome !== "won") {
    throw new Error(`Deal ${opportunityId} isn't won; attendance is owed only on a won deal`);
  }
  const meetingIds: Id<"meetings">[] = [];
  for (const meeting of await scheduledMeetings(ctx, deal)) {
    if (meeting._id === options.exceptMeetingId) continue;
    const owedSince = meeting.scheduledAt + meeting.durationMinutes * 60_000;
    if (meeting.attendanceOwedSince === owedSince) continue;
    await patchMeetingLifecycle(ctx, meeting._id, { attendanceOwedSince: owedSince });
    meetingIds.push(meeting._id);
  }
  return { meetingIds };
}

/** Clear the marker on the deal's scheduled meetings, for an exclusion that leaves won. */
export async function clearAttendanceOwed(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
): Promise<{ meetingIds: Id<"meetings">[] }> {
  const deal = await readDeal(ctx, opportunityId);
  const meetingIds: Id<"meetings">[] = [];
  for (const meeting of await scheduledMeetings(ctx, deal)) {
    if (meeting.attendanceOwedSince === undefined) continue;
    await patchMeetingLifecycle(ctx, meeting._id, { attendanceOwedSince: undefined });
    meetingIds.push(meeting._id);
  }
  return { meetingIds };
}
