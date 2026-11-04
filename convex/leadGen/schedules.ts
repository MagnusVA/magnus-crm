import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { businessDateToUtcStart } from "../reporting/lib/hondurasBusinessTime";
import { createLiveReadState, type LiveReadState } from "../lib/liveQueryBounds";
import { rowInForce } from "../lib/workSchedule";
import { loadScheduleRowsByOwner } from "../workSchedules/rangeHours";

type LeadGenWeekday = Doc<"leadGenWorkerSchedules">["weekday"];
type DailyStatScheduleRow = Pick<
  Doc<"leadGenDailyStats">,
  "workerId" | "dayKey" | "scheduledHours"
>;

const WEEKDAYS: LeadGenWeekday[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

export function leadGenWeekdayForBusinessDate(
  dayKey: string,
): LeadGenWeekday {
  businessDateToUtcStart(dayKey);
  const date = new Date(`${dayKey}T12:00:00.000Z`);
  const weekday = WEEKDAYS[date.getUTCDay()];
  if (!weekday) {
    throw new Error("Invalid business date weekday");
  }
  return weekday;
}

export function leadGenScheduledHoursKey(args: {
  workerId: Id<"leadGenWorkers">;
  dayKey: string;
}) {
  return `${args.workerId}:${args.dayKey}`;
}

export function scheduledHoursForDailyStat(
  row: DailyStatScheduleRow,
  currentScheduledHoursByWorkerDay: Map<string, number>,
) {
  return (
    currentScheduledHoursByWorkerDay.get(
      leadGenScheduledHoursKey({
        workerId: row.workerId,
        dayKey: row.dayKey,
      }),
    ) ?? row.scheduledHours
  );
}

/**
 * Each daily row's scheduled hours: the worker's schedule in force on the
 * row's day (convex/lib/workSchedule.ts, "Dated schedules"), so a change
 * saved today leaves earlier days as they were. A worker-day with no row in
 * force is missing from the map, and `scheduledHoursForDailyStat` falls back
 * to the bucket's snapshot.
 */
export async function loadScheduledHoursByWorkerDay(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    rows: DailyStatScheduleRow[];
    liveReadState?: LiveReadState;
  },
) {
  const workerIds = [...new Set(args.rows.map((row) => row.workerId))];
  const scheduleRowsByWorker = await loadScheduleRowsByOwner(ctx, {
    tenantId: args.tenantId,
    keys: workerIds,
    owner: (workerId) => ({ table: "leadGenWorkerSchedules", workerId }),
    liveReadState: args.liveReadState ?? createLiveReadState(),
  });

  const scheduledHoursByWorkerDay = new Map<string, number>();
  for (const row of args.rows) {
    const scheduleRows = scheduleRowsByWorker.get(row.workerId);
    if (!scheduleRows) continue;
    const schedule = rowInForce(scheduleRows, leadGenWeekdayForBusinessDate(row.dayKey), row.dayKey);
    if (!schedule) continue;

    scheduledHoursByWorkerDay.set(
      leadGenScheduledHoursKey({
        workerId: row.workerId,
        dayKey: row.dayKey,
      }),
      schedule.scheduledHours,
    );
  }

  return scheduledHoursByWorkerDay;
}
