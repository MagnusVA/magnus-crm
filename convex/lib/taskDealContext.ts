import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  buildDealAttributionDetail,
  resolveBookingDmAttribution,
} from "./attribution/detailPayload";

/** The task page lists at most this many of the deal's calls, newest first. */
export const MAX_TASK_DEAL_MEETINGS = 20;

/**
 * What the task page's deal cards read beside the task: the deal's calls,
 * who gets credit, and its closer. The closer and admin task queries
 * (`closer/reminderDetail.ts`, `pipeline/reminderDetail.ts`) both return it,
 * so the two pages render the same cards. Read only.
 */
export async function loadTaskDealContext(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  opportunity: Doc<"opportunities">,
) {
  const [meetings, dealAttribution, dmAttribution, assignedCloser] = await Promise.all([
    ctx.db
      .query("meetings")
      .withIndex("by_opportunityId_and_scheduledAt", (q) =>
        q.eq("opportunityId", opportunity._id),
      )
      .order("desc")
      .take(MAX_TASK_DEAL_MEETINGS),
    buildDealAttributionDetail(ctx, opportunity),
    // The deal's first booking names the team and DM closer when the deal
    // has no credit rows (docs/plans/phase-3-attribution.md §6.5).
    resolveBookingDmAttribution(ctx, { tenantId, opportunity, meeting: null }),
    opportunity.assignedCloserId
      ? ctx.db.get("users", opportunity.assignedCloserId)
      : Promise.resolve(null),
  ]);

  const tenantMeetings = meetings.filter((meeting) => meeting.tenantId === tenantId);
  const latestComments = await Promise.all(
    tenantMeetings.map((meeting) => latestMeetingComment(ctx, meeting._id)),
  );

  return {
    dealMeetings: tenantMeetings.map((meeting, index) => ({
      _id: meeting._id,
      scheduledAt: meeting.scheduledAt,
      durationMinutes: meeting.durationMinutes,
      status: meeting.status,
      detail: meetingDetailLine(meeting, latestComments[index]),
    })),
    dealAttribution,
    attributionTeam: dmAttribution.team
      ? { displayName: dmAttribution.team.displayName }
      : null,
    dmCloser: dmAttribution.dmCloser
      ? { displayName: dmAttribution.dmCloser.displayName }
      : null,
    // The deal's working closer, named in the credit line when the deal has
    // no credit rows. Not `assignedCloser`, which the admin query uses for
    // the task's closer.
    dealCloser:
      assignedCloser && assignedCloser.tenantId === tenantId
        ? { fullName: assignedCloser.fullName, email: assignedCloser.email }
        : null,
  };
}

const NO_SHOW_REASON_LABELS: Record<NonNullable<Doc<"meetings">["noShowReason"]>, string> = {
  no_response: "No response",
  late_cancel: "Canceled late",
  technical_issues: "Technical issues",
  other: "Other reason",
};

/** The newest comment on a call that hasn't been deleted, from its last few. */
async function latestMeetingComment(ctx: QueryCtx, meetingId: Id<"meetings">) {
  const recent = await ctx.db
    .query("meetingComments")
    .withIndex("by_meetingId_and_createdAt", (q) => q.eq("meetingId", meetingId))
    .order("desc")
    .take(3);
  return recent.find((comment) => comment.deletedAt === undefined)?.content ?? null;
}

/**
 * One line on what happened on a call, for the task page's call rows: the
 * no-show's note or reason, else the newest comment, else whether it was a
 * rescheduled call. Null when there's nothing to say.
 */
function meetingDetailLine(meeting: Doc<"meetings">, latestComment: string | null): string | null {
  if (meeting.status === "no_show") {
    const note = meeting.noShowNote?.trim();
    if (note) return note;
    if (meeting.noShowReason) return NO_SHOW_REASON_LABELS[meeting.noShowReason];
  }
  const comment = latestComment?.trim();
  if (comment) return comment;
  return meeting.rescheduledFromMeetingId ? "Rescheduled call" : null;
}
