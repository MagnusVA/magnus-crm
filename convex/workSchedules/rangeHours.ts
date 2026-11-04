import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { addBusinessDays } from "../reporting/lib/hondurasBusinessTime";
import { hoursOverDays } from "../lib/workSchedule";
import { createLiveReadState, type LiveReadState } from "../lib/liveQueryBounds";
import { readScheduleRows, type ScheduleOwner, type ScheduleRow } from "./datedRows";

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

/**
 * Every schedule row of each owner, read per owner. Stops at the first
 * owner whose read is capped (`liveReadState.capped` tells the caller), so a
 * returned owner's rows are always complete.
 */
export async function loadScheduleRowsByOwner<Key>(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    keys: Iterable<Key>;
    owner: (key: Key) => ScheduleOwner;
    liveReadState?: LiveReadState;
  },
): Promise<Map<Key, ScheduleRow[]>> {
  const state = args.liveReadState ?? createLiveReadState();
  const result = new Map<Key, ScheduleRow[]>();
  for (const key of args.keys) {
    if (result.has(key)) continue;
    const scan = await readScheduleRows(ctx, args.tenantId, args.owner(key), state);
    if (scan.capped) break;
    result.set(key, scan.rows);
  }
  return result;
}

async function loadHoursForRange<Key>(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    keys: Key[];
    owner: (key: Key) => ScheduleOwner;
    startBusinessDate: string;
    endBusinessDateInclusive: string;
    liveReadState?: LiveReadState;
  },
) {
  const businessDates = businessDatesInInclusiveRange(args);
  const rowsByOwner = await loadScheduleRowsByOwner(ctx, args);
  const result = new Map<Key, number>();
  for (const [key, rows] of rowsByOwner) {
    // Each day under the schedule in force that day.
    result.set(key, hoursOverDays(rows, businessDates));
  }
  return result;
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
  return await loadHoursForRange(ctx, {
    ...args,
    keys: args.workerIds,
    owner: (workerId) => ({ table: "leadGenWorkerSchedules", workerId }),
  });
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
  return await loadHoursForRange(ctx, {
    ...args,
    keys: args.slackUserIds,
    owner: (slackUserId) => ({ table: "slackQualifierSchedules", slackUserId }),
  });
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
  return await loadHoursForRange(ctx, {
    ...args,
    keys: args.dmCloserIds,
    owner: (dmCloserId) => ({ table: "dmCloserSchedules", dmCloserId }),
  });
}
