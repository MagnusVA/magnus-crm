import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { addBusinessDays } from "../reporting/lib/hondurasBusinessTime";
import { type Weekday, weekdayForBusinessDate } from "../lib/workSchedule";
import {
  createLiveReadState,
  readLiveQueryRows,
  type LiveReadState,
} from "../lib/liveQueryBounds";

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
    liveReadState?: LiveReadState;
  },
) {
  const businessDates = businessDatesInInclusiveRange(args);
  const result = new Map<Id<"leadGenWorkers">, number>();

  const state = args.liveReadState ?? createLiveReadState();
  for (const workerId of args.workerIds) {
    const scan = await readLiveQueryRows(
      ctx.db
        .query("leadGenWorkerSchedules")
        .withIndex("by_tenantId_and_workerId", (q) =>
          q.eq("tenantId", args.tenantId).eq("workerId", workerId),
        ),
      7,
      state,
    );
    if (scan.capped) break;
    result.set(workerId, sumHoursForWeekdayRows(scan.rows, businessDates));
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
    liveReadState?: LiveReadState;
  },
) {
  const businessDates = businessDatesInInclusiveRange(args);
  const result = new Map<string, number>();

  const state = args.liveReadState ?? createLiveReadState();
  for (const slackUserId of args.slackUserIds) {
    const scan = await readLiveQueryRows(
      ctx.db
        .query("slackQualifierSchedules")
        .withIndex("by_tenantId_and_slackUserId", (q) =>
          q.eq("tenantId", args.tenantId).eq("slackUserId", slackUserId),
        ),
      7,
      state,
    );
    if (scan.capped) break;
    result.set(slackUserId, sumHoursForWeekdayRows(scan.rows, businessDates));
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
    liveReadState?: LiveReadState;
  },
) {
  const businessDates = businessDatesInInclusiveRange(args);
  const result = new Map<Id<"dmClosers">, number>();

  const state = args.liveReadState ?? createLiveReadState();
  for (const dmCloserId of args.dmCloserIds) {
    const scan = await readLiveQueryRows(
      ctx.db
        .query("dmCloserSchedules")
        .withIndex("by_tenantId_and_dmCloserId", (q) =>
          q.eq("tenantId", args.tenantId).eq("dmCloserId", dmCloserId),
        ),
      7,
      state,
    );
    if (scan.capped) break;
    result.set(dmCloserId, sumHoursForWeekdayRows(scan.rows, businessDates));
  }

  return result;
}
