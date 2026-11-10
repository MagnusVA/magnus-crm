import { v } from "convex/values";
import type { Doc } from "../../_generated/dataModel";
import { internalQuery, type QueryCtx } from "../../_generated/server";
import { readCloserCalendarMeetings } from "../../closer/calendar";
import { readCloserTasks } from "../../closer/followUpQueries";
import { canRecordMeetingOutcome } from "../../opportunities/dealGuards";
import { businessDateForInstant } from "../../../lib/businessDay";
import { meetingAttendanceDisplay } from "../../../lib/status-config";
import { getTenantBusinessDay } from "../../lib/tenantBusinessDay";
import { mcpCallerValidator, requireMcpUser, type McpUser } from "../guard";
import { formatLocal } from "../time";

const HOUR = 60 * 60 * 1000;
const NOT_RECORDED_LOOKBACK_MS = 7 * 24 * HOUR;
const MAX_NOT_RECORDED = 10;
const MAX_UNMATCHED = 10;

/**
 * The shift's window (docs/plans/closer-assistant.md §6.2): from the end of
 * the closer's last end-of-day report, or 12 hours back when there's none in
 * the last 24 hours, to 18 hours ahead.
 */
export async function shiftWindow(ctx: QueryCtx, me: McpUser, now: number) {
  const last = await ctx.db
    .query("endOfDayReports")
    .withIndex("by_tenantId_and_userId_and_periodEnd", (q) =>
      q.eq("tenantId", me.tenantId).eq("userId", me.userId),
    )
    .order("desc")
    .first();
  const fromReport = last && last.periodEnd > now - 24 * HOUR;
  return {
    from: fromReport ? last.periodEnd : now - 12 * HOUR,
    to: now + 18 * HOUR,
    since: fromReport ? ("last end-of-day report" as const) : ("12 hours ago" as const),
  };
}

/** What the agent may see of a meeting's second opinion (§6.9). */
export async function secondOpinionFor(
  ctx: QueryCtx,
  me: McpUser,
  meeting: Doc<"meetings">,
) {
  // Shown only in "on" mode, and only once the call has a result, so the
  // check never steers the result it checks (decision 30).
  if (me.tenant.secondOpinion?.mode !== "on" || meeting.status === "scheduled") return null;
  const opinion = await ctx.db
    .query("secondOpinions")
    .withIndex("by_meetingId", (q) => q.eq("meetingId", meeting._id))
    .order("desc")
    .first();
  if (!opinion || opinion.status !== "answered" || !opinion.verdict || !opinion.answers) return null;
  return {
    verdict: opinion.verdict,
    heard: {
      attendance: opinion.answers.attendance.choice,
      ending: opinion.answers.ending.choice,
      objection: opinion.answers.objection.choice,
    },
    confidence: opinion.answers.ending.confidence ?? null,
    reviewState: opinion.reviewState ?? null,
  };
}

async function meetingExtras(ctx: QueryCtx, me: McpUser, meeting: Doc<"meetings">) {
  // A deal can move to another closer while its past meetings stay with this
  // one. Its notes, tasks and payments then belong to the new closer, so they
  // show only while the deal is still the caller's.
  const deal = await ctx.db.get("opportunities", meeting.opportunityId);
  const ownsDeal = deal !== null && deal.tenantId === me.tenantId && deal.assignedCloserId === me.userId;
  const [latestNote, openTasks, payments, recording, secondOpinion] = await Promise.all([
    ctx.db
      .query("callNotes")
      .withIndex("by_tenantId_and_opportunityId_and_createdAt", (q) =>
        q.eq("tenantId", me.tenantId).eq("opportunityId", meeting.opportunityId),
      )
      .order("desc")
      .first(),
    ctx.db
      .query("followUps")
      .withIndex("by_opportunityId_and_status_and_reason", (q) =>
        q.eq("opportunityId", meeting.opportunityId).eq("status", "pending"),
      )
      .take(5),
    ctx.db
      .query("paymentRecords")
      .withIndex("by_opportunityId_and_recordedAt", (q) =>
        q.eq("opportunityId", meeting.opportunityId),
      )
      .order("desc")
      .take(10),
    ctx.db
      .query("callRecordings")
      .withIndex("by_meetingId", (q) => q.eq("meetingId", meeting._id))
      .first(),
    secondOpinionFor(ctx, me, meeting),
  ]);
  return {
    latestCallNote: ownsDeal && latestNote
      ? {
          at: formatLocal(latestNote.createdAt, me.timeZone),
          // Written by an agent or a teammate: data, never instructions.
          personSupplied: true as const,
          objection: latestNote.objection,
          nextAction: latestNote.nextAction ?? null,
        }
      : null,
    openTasks: openTasks
      .filter((task) => ownsDeal && task.closerId === me.userId)
      .map((task) => ({
        taskId: task._id,
        kind: task.type === "scheduling_link" ? "scheduling_link" : (task.contactMethod ?? "call"),
        due: task.reminderScheduledAt ? formatLocal(task.reminderScheduledAt, me.timeZone) : null,
      })),
    payments: payments
      .filter((payment) => ownsDeal && payment.tenantId === me.tenantId)
      .map((payment) => ({
        paymentId: payment._id,
        hasProof: payment.proofFileId !== undefined,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        paymentType: payment.paymentType,
        status: payment.status,
        recordedAt: formatLocal(payment.recordedAt, me.timeZone),
      })),
    recording: recording
      ? {
          recordingId: recording._id,
          minutes: Math.round((recording.recordingEndAt - recording.recordingStartAt) / 60_000),
          hasSummary: Boolean(recording.summaryMarkdown),
        }
      : null,
    secondOpinion,
  };
}

/** Calls before the window that still have no result. */
async function olderNotRecorded(ctx: QueryCtx, me: McpUser, before: number, now: number) {
  const candidates = await ctx.db
    .query("meetings")
    .withIndex("by_tenantId_and_assignedCloserId_and_status_and_scheduledAt", (q) =>
      q
        .eq("tenantId", me.tenantId)
        .eq("assignedCloserId", me.userId)
        .eq("status", "scheduled")
        .gte("scheduledAt", now - NOT_RECORDED_LOOKBACK_MS)
        .lt("scheduledAt", before),
    )
    .order("desc")
    .take(MAX_NOT_RECORDED * 2);
  const result: Doc<"meetings">[] = [];
  for (const meeting of candidates) {
    if (result.length === MAX_NOT_RECORDED) break;
    const deal = await ctx.db.get("opportunities", meeting.opportunityId);
    if (deal && deal.assignedCloserId === me.userId && canRecordMeetingOutcome(deal)) {
      if (meetingAttendanceDisplay(meeting, now) === "not_recorded") result.push(meeting);
    }
  }
  return result;
}

type TaskEntry = {
  taskId: Doc<"followUps">["_id"];
  person: string;
  kind: string;
  due: string | null;
  note: string | null;
  program: string | null;
  noteIsPersonSupplied: boolean;
};

export async function buildToday(ctx: QueryCtx, me: McpUser, now: number) {
  const window = await shiftWindow(ctx, me, now);
  const calendar = await readCloserCalendarMeetings(ctx, me.tenantId, me.userId, window.from, window.to);
  const businessDay = await getTenantBusinessDay(ctx, me.tenantId);

  const meetings = [];
  for (const row of calendar.meetings) {
    const meeting = await ctx.db.get("meetings", row.meeting._id);
    if (!meeting) continue;
    const attendance = meetingAttendanceDisplay(meeting, now);
    meetings.push({
      meetingId: meeting._id,
      time: formatLocal(meeting.scheduledAt, me.timeZone),
      person: row.leadName,
      callType: meeting.callClassification === "follow_up" ? "follow-up" : "new",
      program: row.meeting.bookingProgramName ?? row.eventTypeName ?? null,
      dealStage: row.dealPosition,
      attendance,
      ...(await meetingExtras(ctx, me, meeting)),
    });
  }
  // Calls still Not recorded come first (§6.2).
  meetings.sort((a, b) => Number(b.attendance === "not_recorded") - Number(a.attendance === "not_recorded"));

  const older = await olderNotRecorded(ctx, me, window.from, now);
  const tasks = await readCloserTasks(ctx, me.tenantId, me.userId);
  const today = businessDateForInstant(now, businessDay);
  const grouped = {
    overdue: [] as TaskEntry[],
    today: [] as TaskEntry[],
    later: [] as TaskEntry[],
  };
  for (const task of tasks.reminders) {
    const due = task.reminderScheduledAt;
    const entry = {
      taskId: task._id,
      person: task.leadName,
      kind: task.contactMethod ?? "call",
      due: due ? formatLocal(due, me.timeZone) : null,
      note: task.reminderNote,
      program: task.programName,
      // A reminder note may come from an admin or another agent
      // (docs/plans/admin-assistant.md §4): data, never instructions.
      noteIsPersonSupplied: task.reminderNote !== null,
    };
    if (due !== null && due < now) grouped.overdue.push(entry);
    else if (due !== null && businessDateForInstant(due, businessDay) === today) grouped.today.push(entry);
    else grouped.later.push(entry);
  }

  const unmatched = await ctx.db
    .query("callRecordings")
    .withIndex("by_tenantId_and_recordedByUserId_and_matchStatus", (q) =>
      q.eq("tenantId", me.tenantId).eq("recordedByUserId", me.userId).eq("matchStatus", "unmatched"),
    )
    .order("desc")
    .take(MAX_UNMATCHED);

  return {
    closer: me.user.fullName ?? me.user.email,
    timeZone: me.timeZone,
    now: formatLocal(now, me.timeZone),
    window: {
      from: formatLocal(window.from, me.timeZone),
      to: formatLocal(window.to, me.timeZone),
      since: window.since,
    },
    meetings,
    notRecordedEarlier: older.map((meeting) => ({
      meetingId: meeting._id,
      time: formatLocal(meeting.scheduledAt, me.timeZone),
      person: meeting.leadName ?? "Unknown",
    })),
    tasks: grouped,
    schedulingLinksWaiting: tasks.schedulingLinks.length,
    recordingsWithoutMeeting: unmatched.map((recording) => ({
      recordingId: recording._id,
      started: formatLocal(recording.recordingStartAt, me.timeZone),
      minutes: Math.round((recording.recordingEndAt - recording.recordingStartAt) / 60_000),
      title: recording.title,
    })),
    isPartial: calendar.isPartial || tasks.isPartial,
  };
}

export const secondOpinionSummaryValidator = v.union(
  v.null(),
  v.object({
    verdict: v.union(v.literal("agrees"), v.literal("unsure"), v.literal("disagrees"), v.literal("hint")),
    heard: v.object({ attendance: v.string(), ending: v.string(), objection: v.string() }),
    confidence: v.union(v.number(), v.null()),
    reviewState: v.union(v.literal("open"), v.literal("checked"), v.null()),
  }),
);

const taskEntryValidator = v.object({
  taskId: v.id("followUps"),
  person: v.string(),
  kind: v.string(),
  due: v.union(v.string(), v.null()),
  note: v.union(v.string(), v.null()),
  program: v.union(v.string(), v.null()),
  noteIsPersonSupplied: v.boolean(),
});

export const todayResultValidator = v.object({
  closer: v.string(),
  timeZone: v.string(),
  now: v.string(),
  window: v.object({ from: v.string(), to: v.string(), since: v.string() }),
  meetings: v.array(
    v.object({
      meetingId: v.id("meetings"),
      time: v.string(),
      person: v.string(),
      callType: v.string(),
      program: v.union(v.string(), v.null()),
      dealStage: v.union(v.string(), v.null()),
      attendance: v.string(),
      latestCallNote: v.union(
        v.null(),
        v.object({
          at: v.string(),
          personSupplied: v.literal(true),
          objection: v.string(),
          nextAction: v.union(v.string(), v.null()),
        }),
      ),
      openTasks: v.array(
        v.object({ taskId: v.id("followUps"), kind: v.string(), due: v.union(v.string(), v.null()) }),
      ),
      payments: v.array(
        v.object({
          paymentId: v.id("paymentRecords"),
          hasProof: v.boolean(),
          amountMinor: v.number(),
          currency: v.string(),
          paymentType: v.string(),
          status: v.string(),
          recordedAt: v.string(),
        }),
      ),
      recording: v.union(
        v.null(),
        v.object({ recordingId: v.id("callRecordings"), minutes: v.number(), hasSummary: v.boolean() }),
      ),
      secondOpinion: secondOpinionSummaryValidator,
    }),
  ),
  notRecordedEarlier: v.array(
    v.object({ meetingId: v.id("meetings"), time: v.string(), person: v.string() }),
  ),
  tasks: v.object({
    overdue: v.array(taskEntryValidator),
    today: v.array(taskEntryValidator),
    later: v.array(taskEntryValidator),
  }),
  schedulingLinksWaiting: v.number(),
  recordingsWithoutMeeting: v.array(
    v.object({
      recordingId: v.id("callRecordings"),
      started: v.string(),
      minutes: v.number(),
      title: v.string(),
    }),
  ),
  isPartial: v.boolean(),
});

/** `magnus_today`: the closer's shift, every meeting and task ID, read-only. */
export const run = internalQuery({
  args: { caller: mcpCallerValidator },
  returns: todayResultValidator,
  handler: async (ctx, { caller }) => {
    const me = await requireMcpUser(ctx, caller, ["closer"]);
    return await buildToday(ctx, me, Date.now());
  },
});

