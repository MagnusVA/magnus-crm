import { getTenantBusinessDay } from "./tenantBusinessDay";
import type { BusinessDaySetting } from "../../lib/businessDay";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { meetingAttendanceDisplay } from "../../lib/status-config";
import {
  addBusinessDays,
  businessDateToUtcStart,
  timestampToBusinessDateKey,
} from "../reporting/lib/hondurasBusinessTime";

export function isHeldStatus(status: string): status is "held" {
  return status === "held";
}

type AttendanceCount = Pick<
  Doc<"operationsMeetingStatsV2">,
  | "dayKey"
  | "assignedCloserId"
  | "bookingProgramId"
  | "soldProgramId"
  | "meetingStatus"
  | "count"
> & { meetingId?: Id<"meetings"> };

function countKey(
  row: Omit<AttendanceCount, "count" | "meetingStatus">,
): string {
  return JSON.stringify([
    row.dayKey,
    row.assignedCloserId,
    row.bookingProgramId ?? null,
    row.soldProgramId ?? null,
  ]);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ATTENDANCE_READ_LIMIT = 500;

/**
 * Meetings older than 24 hours have ended. Read recent scheduled calls through
 * the business day's end once, then split the business-day buckets by end time.
 * Unread calls before the window have finished; unread calls after it are
 * upcoming. At the cap, only buckets before the last read call are covered.
 */
export async function withAttendanceCounts<T extends AttendanceCount>(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  rows: T[],
  now = Date.now(),
  limit = ATTENDANCE_READ_LIMIT,
): Promise<{
  counts: Array<T & { notRecorded: number }>;
  attendanceCountsPartial: boolean;
}> {
  const setting = await getTenantBusinessDay(ctx, tenantId);
  const { start, end } = attendanceDayBounds(now, setting);
  const firstDay = timestampToBusinessDateKey(start, setting);
  const lastDay = timestampToBusinessDateKey(end - 1, setting);
  const needsEndTimes = rows.some(
    (row) =>
      row.meetingStatus === "scheduled" &&
      row.dayKey >= firstDay &&
      row.dayKey <= lastDay,
  );
  const finishedByKey = new Map<string, number>();
  const unfinishedByKey = new Map<string, number>();
  const finishedIds = new Set<Id<"meetings">>();
  const unfinishedIds = new Set<Id<"meetings">>();
  let attendanceCountsPartial = false;
  let coveredEnd = end;
  if (needsEndTimes) {
    const result = await readScheduledAttendanceDay(ctx, tenantId, now, limit);
    const { meetings } = result;
    attendanceCountsPartial = result.attendanceCountsPartial;
    if (attendanceCountsPartial) {
      // Calls sharing the last timestamp can also be unread.
      coveredEnd = meetings[meetings.length - 1].scheduledAt;
    }
    for (const meeting of meetings) {
      const finished =
        meetingAttendanceDisplay(meeting, now) === "not_recorded";
      (finished ? finishedIds : unfinishedIds).add(meeting._id);
      const key = countKey({
        ...meeting,
        dayKey: timestampToBusinessDateKey(meeting.scheduledAt, setting),
      });
      const counts = finished ? finishedByKey : unfinishedByKey;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const counts = rows.map((row) => {
    let notRecorded = 0;
    if (row.meetingStatus === "scheduled") {
      if (row.dayKey < firstDay) {
        notRecorded = row.count;
      } else if (businessDateToUtcStart(addBusinessDays(row.dayKey, 1), setting) <= coveredEnd) {
        notRecorded = row.meetingId
          ? Number(!unfinishedIds.has(row.meetingId))
          : Math.max(0, row.count - (unfinishedByKey.get(countKey(row)) ?? 0));
      } else if (businessDateToUtcStart(row.dayKey, setting) <= coveredEnd) {
        notRecorded = row.meetingId
          ? Number(finishedIds.has(row.meetingId))
          : Math.min(row.count, finishedByKey.get(countKey(row)) ?? 0);
      }
    }
    return { ...row, notRecorded };
  });
  return { counts, attendanceCountsPartial };
}

export function attendanceDayBounds(now: number, setting?: BusinessDaySetting) {
  const today = timestampToBusinessDateKey(now, setting);
  return {
    start: Math.min(businessDateToUtcStart(today, setting), now - DAY_MS),
    end: businessDateToUtcStart(addBusinessDays(today, 1), setting),
  };
}

export async function readScheduledAttendanceDay(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  now: number,
  limit = ATTENDANCE_READ_LIMIT,
) {
  const setting = await getTenantBusinessDay(ctx, tenantId);
  const { start, end } = attendanceDayBounds(now, setting);
  const meetings = await ctx.db
    .query("meetings")
    .withIndex("by_tenantId_and_status_and_scheduledAt", (q) =>
      q
        .eq("tenantId", tenantId)
        .eq("status", "scheduled")
        .gte("scheduledAt", start)
        .lt("scheduledAt", end),
    )
    .take(limit);
  return { meetings, attendanceCountsPartial: meetings.length === limit };
}
