import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { addBusinessDays } from "../reporting/lib/hondurasBusinessTime";
import { type Weekday, weekdayForBusinessDate } from "../lib/workSchedule";

export function businessDatesInInclusiveRange(args: {
  startBusinessDate: string;
  endBusinessDateInclusive: string;
}) {
  const days: string[] = [];
  for (
    let day = args.startBusinessDate;
    day <= args.endBusinessDateInclusive;
    day = addBusinessDays(day, 1)
  ) {
    days.push(day);
  }
  return days;
}

function sumHoursForWeekdayRows(
  rows: Array<{ weekday: Weekday; scheduledHours: number }>,
  businessDates: string[],
) {
  const byWeekday = new Map(rows.map((row) => [row.weekday, row.scheduledHours]));
  return businessDates.reduce((sum, dayKey) => {
    const weekday = weekdayForBusinessDate(dayKey);
    return sum + (byWeekday.get(weekday) ?? 0);
  }, 0);
}

export async function loadLeadGenScheduledHoursForRange(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    workerIds: Id<"leadGenWorkers">[];
    startBusinessDate: string;
    endBusinessDateInclusive: string;
  },
) {
  const businessDates = businessDatesInInclusiveRange(args);
  const result = new Map<Id<"leadGenWorkers">, number>();

  for (const workerId of args.workerIds) {
    const rows = await ctx.db
      .query("leadGenWorkerSchedules")
      .withIndex("by_tenantId_and_workerId", (q) =>
        q.eq("tenantId", args.tenantId).eq("workerId", workerId),
      )
      .take(7);
    result.set(workerId, sumHoursForWeekdayRows(rows, businessDates));
  }

  return result;
}

export async function loadSlackQualifierScheduledHoursForRange(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    slackUserIds: string[];
    startBusinessDate: string;
    endBusinessDateInclusive: string;
  },
) {
  const businessDates = businessDatesInInclusiveRange(args);
  const result = new Map<string, number>();

  for (const slackUserId of args.slackUserIds) {
    const rows = await ctx.db
      .query("slackQualifierSchedules")
      .withIndex("by_tenantId_and_slackUserId", (q) =>
        q.eq("tenantId", args.tenantId).eq("slackUserId", slackUserId),
      )
      .take(7);
    result.set(slackUserId, sumHoursForWeekdayRows(rows, businessDates));
  }

  return result;
}

export async function loadDmCloserScheduledHoursForRange(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    dmCloserIds: Id<"dmClosers">[];
    startBusinessDate: string;
    endBusinessDateInclusive: string;
  },
) {
  const businessDates = businessDatesInInclusiveRange(args);
  const result = new Map<Id<"dmClosers">, number>();

  for (const dmCloserId of args.dmCloserIds) {
    const rows = await ctx.db
      .query("dmCloserSchedules")
      .withIndex("by_tenantId_and_dmCloserId", (q) =>
        q.eq("tenantId", args.tenantId).eq("dmCloserId", dmCloserId),
      )
      .take(7);
    result.set(dmCloserId, sumHoursForWeekdayRows(rows, businessDates));
  }

  return result;
}
