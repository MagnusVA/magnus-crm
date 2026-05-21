import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export function meetingDayKey(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function sameStatsBucket(a: Doc<"meetings">, b: Doc<"meetings">) {
  return (
    a.tenantId === b.tenantId &&
    a.assignedCloserId === b.assignedCloserId &&
    a.bookingProgramId === b.bookingProgramId &&
    a.soldProgramId === b.soldProgramId &&
    a.attributionTeamId === b.attributionTeamId &&
    a.dmCloserId === b.dmCloserId &&
    a.opportunityStatus === b.opportunityStatus &&
    a.status === b.status &&
    meetingDayKey(a.scheduledAt) === meetingDayKey(b.scheduledAt)
  );
}

async function incrementMeetingStatsBucket(
  ctx: MutationCtx,
  meeting: Doc<"meetings">,
  delta: 1 | -1,
) {
  const key = meetingDayKey(meeting.scheduledAt);
  const candidates = await ctx.db
    .query("operationsMeetingDailyStats")
    .withIndex("by_tenantId_and_assignedCloserId_and_dayKey", (q) =>
      q
        .eq("tenantId", meeting.tenantId)
        .eq("assignedCloserId", meeting.assignedCloserId)
        .eq("dayKey", key),
    )
    .take(200);

  const existing = candidates.find(
    (row) =>
      row.bookingProgramId === meeting.bookingProgramId &&
      row.soldProgramId === meeting.soldProgramId &&
      row.attributionTeamId === meeting.attributionTeamId &&
      row.dmCloserId === meeting.dmCloserId &&
      row.opportunityStatus === meeting.opportunityStatus &&
      row.meetingStatus === meeting.status,
  );

  if (existing) {
    const count = existing.count + delta;
    if (count <= 0) {
      await ctx.db.delete(existing._id);
    } else {
      await ctx.db.patch(existing._id, { count, updatedAt: Date.now() });
    }
    return;
  }

  if (delta > 0) {
    await ctx.db.insert("operationsMeetingDailyStats", {
      tenantId: meeting.tenantId,
      dayKey: key,
      assignedCloserId: meeting.assignedCloserId,
      bookingProgramId: meeting.bookingProgramId,
      soldProgramId: meeting.soldProgramId,
      attributionTeamId: meeting.attributionTeamId,
      dmCloserId: meeting.dmCloserId,
      opportunityStatus: meeting.opportunityStatus,
      meetingStatus: meeting.status,
      count: 1,
      updatedAt: Date.now(),
    });
  }
}

async function markStatsSynced(ctx: MutationCtx, meeting: Doc<"meetings">) {
  await ctx.db.patch(meeting._id, { operationsStatsSyncedAt: Date.now() });
}

export async function insertOperationsMeetingStats(
  ctx: MutationCtx,
  meeting: Doc<"meetings">,
) {
  if (meeting.operationsStatsSyncedAt !== undefined) {
    return;
  }
  await incrementMeetingStatsBucket(ctx, meeting, 1);
  await markStatsSynced(ctx, meeting);
}

export async function replaceOperationsMeetingStats(
  ctx: MutationCtx,
  oldMeeting: Doc<"meetings">,
  nextMeeting: Doc<"meetings">,
) {
  if (sameStatsBucket(oldMeeting, nextMeeting)) {
    if (oldMeeting.operationsStatsSyncedAt === undefined) {
      await incrementMeetingStatsBucket(ctx, nextMeeting, 1);
    }
    await markStatsSynced(ctx, nextMeeting);
    return;
  }
  if (oldMeeting.operationsStatsSyncedAt !== undefined) {
    await incrementMeetingStatsBucket(ctx, oldMeeting, -1);
  }
  await incrementMeetingStatsBucket(ctx, nextMeeting, 1);
  await markStatsSynced(ctx, nextMeeting);
}
