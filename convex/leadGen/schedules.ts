import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { businessDateToUtcStart } from "../reporting/lib/hondurasBusinessTime";

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

export async function loadCurrentScheduledHoursByWorkerDay(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    rows: DailyStatScheduleRow[];
  },
) {
  const workerIds = [...new Set(args.rows.map((row) => row.workerId))];
  const dayKeys = [...new Set(args.rows.map((row) => row.dayKey))];
  const weekdayByDayKey = new Map(
    dayKeys.map((dayKey) => [dayKey, leadGenWeekdayForBusinessDate(dayKey)]),
  );
  const scheduledHoursByWorkerWeekday = new Map<string, number>();

  for (const workerId of workerIds) {
    const schedules = await ctx.db
      .query("leadGenWorkerSchedules")
      .withIndex("by_tenantId_and_workerId", (q) =>
        q.eq("tenantId", args.tenantId).eq("workerId", workerId),
      )
      .take(7);

    for (const schedule of schedules) {
      scheduledHoursByWorkerWeekday.set(
        `${workerId}:${schedule.weekday}`,
        schedule.scheduledHours,
      );
    }
  }

  const scheduledHoursByWorkerDay = new Map<string, number>();
  for (const row of args.rows) {
    const weekday = weekdayByDayKey.get(row.dayKey);
    if (!weekday) continue;

    const scheduledHours = scheduledHoursByWorkerWeekday.get(
      `${row.workerId}:${weekday}`,
    );
    if (scheduledHours === undefined) continue;

    scheduledHoursByWorkerDay.set(
      leadGenScheduledHoursKey({
        workerId: row.workerId,
        dayKey: row.dayKey,
      }),
      scheduledHours,
    );
  }

  return scheduledHoursByWorkerDay;
}
