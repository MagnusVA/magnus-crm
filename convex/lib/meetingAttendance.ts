import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { meetingAttendanceDisplay } from "../../lib/status-config";
import {
  addBusinessDays,
  businessDateToUtcStart,
  timestampToBusinessDateKey,
} from "../reporting/lib/hondurasBusinessTime";

/** PR 10 adds the stored `held` value here. */
export function isHeldStatus(status: string): boolean {
  return status === "completed";
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

/**
 * Finished days use rollups. Only today's scheduled calls need end times.
 * Buckets still use UTC until PR 11: today's business day intersects two UTC
 * buckets. The unread part of the first bucket has finished, and the unread
 * part of the second is upcoming. This keeps the read to one business day.
 */
export async function withAttendanceCounts<T extends AttendanceCount>(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  rows: T[],
  now = Date.now(),
): Promise<Array<T & { notRecorded: number }>> {
  const { start, end } = attendanceDayBounds(now);
  const firstDay = new Date(start).toISOString().slice(0, 10);
  const lastDay = new Date(end - 1).toISOString().slice(0, 10);
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
  if (needsEndTimes) {
    const meetings = await readScheduledAttendanceDay(ctx, tenantId, now);
    for (const meeting of meetings) {
      const finished =
        meetingAttendanceDisplay(meeting, now) === "not_recorded";
      (finished ? finishedIds : unfinishedIds).add(meeting._id);
      const key = countKey({
        ...meeting,
        dayKey: new Date(meeting.scheduledAt).toISOString().slice(0, 10),
      });
      const counts = finished ? finishedByKey : unfinishedByKey;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return rows.map((row) => {
    let notRecorded = 0;
    if (row.meetingStatus === "scheduled") {
      if (row.dayKey < firstDay) {
        notRecorded = row.count;
      } else if (row.dayKey === firstDay) {
        notRecorded = row.meetingId
          ? Number(!unfinishedIds.has(row.meetingId))
          : Math.max(0, row.count - (unfinishedByKey.get(countKey(row)) ?? 0));
      } else if (row.dayKey === lastDay) {
        notRecorded = row.meetingId
          ? Number(finishedIds.has(row.meetingId))
          : Math.min(row.count, finishedByKey.get(countKey(row)) ?? 0);
      }
    }
    return { ...row, notRecorded };
  });
}

export function attendanceDayBounds(now: number) {
  const today = timestampToBusinessDateKey(now);
  return {
    start: businessDateToUtcStart(today),
    end: businessDateToUtcStart(addBusinessDays(today, 1)),
  };
}

export async function readScheduledAttendanceDay(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  now: number,
) {
  const { start, end } = attendanceDayBounds(now);
  const meetings = await ctx.db
    .query("meetings")
    .withIndex("by_tenantId_and_status_and_scheduledAt", (q) =>
      q
        .eq("tenantId", tenantId)
        .eq("status", "scheduled")
        .gte("scheduledAt", start)
        .lt("scheduledAt", end),
    )
    .take(200);
  if (meetings.length === 200) {
    throw new Error("Attendance range is too large. Narrow the date range.");
  }
  return meetings;
}
